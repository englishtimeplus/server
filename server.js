const uWS = require('uWebSockets.js');
const Redis = require('ioredis');
const cluster = require('cluster');
const os = require('os');

class FriendOnlineStatusManager {
  constructor(serverId) {
    this.serverId = serverId;
    this.userSockets = new Map(); // userId -> Set of sockets
    this.socketUsers = new Map(); // ws -> userId

    this.redis = new Redis.Cluster([
      { host: 'redis-node-1', port: 6379 },
      { host: 'redis-node-2', port: 6379 },
      { host: 'redis-node-3', port: 6379 }
    ], {
      enableOfflineQueue: false,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3
    });

    this.redisPub = this.redis.duplicate();
    this.redisSub = this.redis.duplicate();

    this.initializeRedisSubscription();
  }

  initializeRedisSubscription() {
    this.redisSub.subscribe('user:online', 'user:offline', 'friend:update');
    this.redisSub.on('message', async (channel, message) => {
      const data = JSON.parse(message);
      const handlers = {
        'user:online': () => this.handleUserOnline(data),
        'user:offline': () => this.handleUserOffline(data),
        'friend:update': () => this.handleFriendUpdate(data)
      };
      if (handlers[channel]) await handlers[channel]();
    });
  }

  initializeWebSocketServer() {
    this.app = uWS.App({
      compression: uWS.SHARED_COMPRESSOR,
      maxCompressedSize: 64 * 1024,
      maxBackpressure: 64 * 1024,
    }).ws('/*', {
      compression: uWS.SHARED_COMPRESSOR,
      maxPayloadLength: 16 * 1024,

      open: (ws) => console.log('WebSocket connection opened'),

      message: async (ws, message, opCode) => {
        try {
          const data = JSON.parse(Buffer.from(message).toString());
          await this.handleMessage(ws, data);
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      },

      close: async (ws) => {
        await this.handleDisconnection(ws);
      }
    });
  }

  async handleMessage(ws, data) {
    const { type, userId, token } = data;

    const actions = {
      auth: () => this.authenticateUser(ws, userId, token),
      get_friends_status: () => this.sendFriendsStatus(userId),
      heartbeat: () => ws.send(JSON.stringify({ type: 'heartbeat_ack' }))
    };

    if (actions[type]) await actions[type]();
    else ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }

  async authenticateUser(ws, userId, token) {
    const valid = await this.validateToken(userId, token);
    if (!valid) {
      ws.send(JSON.stringify({ type: 'auth_failed' }));
      ws.close();
      return;
    }

    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId).add(ws);
    this.socketUsers.set(ws, userId);

    await this.redis.setex(`user:online:${userId}`, 30, this.serverId);
    await this.redis.sadd(`server:${this.serverId}:users`, userId);

    await this.redisPub.publish('user:online', JSON.stringify({
      userId,
      serverId: this.serverId,
      timestamp: Date.now()
    }));

    await this.notifyFriendsAboutStatus(userId, true);
    await this.sendFriendsStatus(userId);

    ws.send(JSON.stringify({ type: 'auth_success' }));
  }

  async handleDisconnection(ws) {
    const userId = this.socketUsers.get(ws);
    if (!userId) return;

    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
        await this.redis.del(`user:online:${userId}`);
        await this.redis.srem(`server:${this.serverId}:users`, userId);
        await this.redisPub.publish('user:offline', JSON.stringify({
          userId,
          serverId: this.serverId,
          timestamp: Date.now()
        }));
        await this.notifyFriendsAboutStatus(userId, false);
      }
    }

    this.socketUsers.delete(ws);
  }

  async handleUserOnline({ userId, serverId }) {
    if (serverId !== this.serverId) {
      await this.notifyFriendsAboutStatus(userId, true);
    }
  }

  async handleUserOffline({ userId, serverId }) {
    if (serverId !== this.serverId) {
      await this.notifyFriendsAboutStatus(userId, false);
    }
  }

  async handleFriendUpdate({ userId, friendId, action }) {
    if (action !== 'add') return;

    const friendOnline = await this.isUserOnline(friendId);
    this.sendToUser(userId, {
      type: 'friend_status',
      friendId,
      online: friendOnline
    });

    const userOnline = await this.isUserOnline(userId);
    this.sendToUser(friendId, {
      type: 'friend_status',
      friendId: userId,
      online: userOnline
    });
  }

  async sendFriendsStatus(userId) {
    const friends = await this.getUserFriends(userId);
    const pipeline = this.redis.pipeline();
    friends.forEach(fid => pipeline.exists(`user:online:${fid}`));
    const results = await pipeline.exec();

    const friendsStatus = friends.map((friendId, i) => ({
      friendId,
      online: results[i][1] === 1
    }));

    this.sendToUser(userId, { type: 'friends_status', friends: friendsStatus });
  }

  async notifyFriendsAboutStatus(userId, isOnline) {
    const friends = await this.getUserFriends(userId);
    const message = {
      type: 'friend_status',
      friendId: userId,
      online: isOnline
    };

    await Promise.allSettled(friends.map(fid => this.sendToUser(fid, message)));
  }

  async sendToUser(userId, message) {
    const sockets = this.userSockets.get(userId);
    const str = JSON.stringify(message);

    if (sockets && sockets.size > 0) {
      for (const ws of sockets) {
        try {
          ws.send(str);
        } catch (e) {
          console.warn(`Send failed to user ${userId}:`, e);
        }
      }
    } else {
      if (await this.isUserOnline(userId)) {
        await this.redisPub.publish(`user:message:${userId}`, str);
      }
    }
  }

  async isUserOnline(userId) {
    return (await this.redis.exists(`user:online:${userId}`)) === 1;
  }

  async getUserFriends(userId) {
    const cacheKey = `friends:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const friends = await this.fetchFriendsFromDB(userId);
    await this.redis.setex(cacheKey, 3600, JSON.stringify(friends));
    return friends;
  }

  async fetchFriendsFromDB(userId) {
    // TODO: Replace with actual DB query
    return [];
  }

  async validateToken(userId, token) {
    // TODO: Replace with JWT or session check
    return true;
  }

  listen(port) {
    this.app.listen(port, (token) => {
      if (!token) {
        console.log(`Failed to listen on port ${port}`);
        process.exit(1);
      }
      console.log(`Listening on port ${port}`);
    });

    this.startHeartbeat();
  }

  startHeartbeat() {
    setInterval(async () => {
      const users = Array.from(this.userSockets.keys());
      const pipeline = this.redis.pipeline();
      users.forEach(userId => {
        pipeline.setex(`user:online:${userId}`, 30, this.serverId);
      });
      await pipeline.exec();
    }, 15000);
  }

  async shutdown() {
    await this.redis.quit();
    await this.redisPub.quit();
    await this.redisSub.quit();
  }
}

// Cluster entry point
if (cluster.isMaster) {
  const numCPUs = os.cpus().length;
  console.log(`Master ${process.pid} is running`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ SERVER_ID: `server-${i}`, PORT: 5555 + i });
  }

  cluster.on('exit', (worker, code) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
} else {
  const serverId = process.env.SERVER_ID || `server-${process.pid}`;
  const port = parseInt(process.env.PORT, 10) || 5555;

  const manager = new FriendOnlineStatusManager(serverId);
  manager.initializeWebSocketServer();
  manager.listen(port);

  process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    await manager.shutdown();
    process.exit(0);
  });
}
