const uWS = require('uWebSockets.js');
const Redis = require('ioredis');
const cluster = require('cluster');
const os = require('os');

// Redis 클러스터 설정
const redis = new Redis.Cluster([
  { host: 'redis-node-1', port: 6379 },
  { host: 'redis-node-2', port: 6379 },
  { host: 'redis-node-3', port: 6379 }
], {
  enableOfflineQueue: false,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3
});

// Pub/Sub용 별도 Redis 연결
const redisPub = redis.duplicate();
const redisSub = redis.duplicate();

class FriendOnlineStatusManager {
  constructor() {
    this.app = null;
    this.userSockets = new Map(); // userId -> Set of websockets
    this.socketUsers = new Map(); // socket -> userId
    this.serverId = process.env.SERVER_ID || `server-${process.pid}`;
    
    this.initializeRedisSubscription();
  }

  // Redis Pub/Sub 초기화
  initializeRedisSubscription() {
    redisSub.subscribe('user:online', 'user:offline', 'friend:update');
    
    redisSub.on('message', async (channel, message) => {
      const data = JSON.parse(message);
      
      switch (channel) {
        case 'user:online':
          await this.handleUserOnline(data);
          break;
        case 'user:offline':
          await this.handleUserOffline(data);
          break;
        case 'friend:update':
          await this.handleFriendUpdate(data);
          break;
      }
    });
  }

  // 사용자 온라인 처리
  async handleUserOnline(data) {
    const { userId, serverId } = data;
    
    // 다른 서버에서 온 이벤트만 처리
    if (serverId !== this.serverId) {
      await this.notifyFriendsAboutStatus(userId, true);
    }
  }

  // 사용자 오프라인 처리
  async handleUserOffline(data) {
    const { userId, serverId } = data;
    
    if (serverId !== this.serverId) {
      await this.notifyFriendsAboutStatus(userId, false);
    }
  }

  // 친구 관계 업데이트 처리
  async handleFriendUpdate(data) {
    const { userId, friendId, action } = data; // action: 'add', 'remove'
    
    if (action === 'add') {
      // 새 친구의 온라인 상태를 해당 사용자에게 전송
      const isOnline = await this.isUserOnline(friendId);
      this.sendToUser(userId, {
        type: 'friend_status',
        friendId,
        online: isOnline
      });
      
      // 해당 사용자의 온라인 상태를 새 친구에게 전송
      const userOnline = await this.isUserOnline(userId);
      this.sendToUser(friendId, {
        type: 'friend_status',
        friendId: userId,
        online: userOnline
      });
    }
  }

  // WebSocket 서버 초기화
  initializeWebSocketServer() {
    this.app = uWS.App({
      compression: uWS.SHARED_COMPRESSOR,
      maxCompressedSize: 64 * 1024,
      maxBackpressure: 64 * 1024,
    }).ws('/*', {
      compression: uWS.OPCODE_BINARY,
      maxPayloadLength: 16 * 1024,
      
      open: async (ws) => {
        console.log('WebSocket connection opened');
      },
      
      message: async (ws, message, opCode) => {
        try {
          const data = JSON.parse(Buffer.from(message).toString());
          await this.handleMessage(ws, data);
        } catch (error) {
          console.error('Message parsing error:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      },
      
      close: async (ws, code, message) => {
        await this.handleDisconnection(ws);
      }
    });
  }

  // 메시지 처리
  async handleMessage(ws, data) {
    const { type, userId, token } = data;
    
    switch (type) {
      case 'auth':
        await this.authenticateUser(ws, userId, token);
        break;
      case 'get_friends_status':
        await this.sendFriendsStatus(userId);
        break;
      case 'heartbeat':
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        break;
    }
  }

  // 사용자 인증 및 온라인 상태 설정
  async authenticateUser(ws, userId, token) {
    // 토큰 검증 로직 (실제 구현에서는 JWT 검증 등)
    const isValid = await this.validateToken(userId, token);
    
    if (!isValid) {
      ws.send(JSON.stringify({ type: 'auth_failed' }));
      ws.close();
      return;
    }

    // 사용자 소켓 매핑
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId).add(ws);
    this.socketUsers.set(ws, userId);

    // Redis에 온라인 상태 저장 (TTL 30초, heartbeat로 갱신)
    await redis.setex(`user:online:${userId}`, 30, this.serverId);
    await redis.sadd(`server:${this.serverId}:users`, userId);

    // 다른 서버에 온라인 상태 알림
    await redisPub.publish('user:online', JSON.stringify({
      userId,
      serverId: this.serverId,
      timestamp: Date.now()
    }));

    // 친구들에게 온라인 상태 알림
    await this.notifyFriendsAboutStatus(userId, true);

    // 친구들의 현재 온라인 상태 전송
    await this.sendFriendsStatus(userId);

    ws.send(JSON.stringify({ type: 'auth_success' }));
  }

  // 연결 해제 처리
  async handleDisconnection(ws) {
    const userId = this.socketUsers.get(ws);
    if (!userId) return;

    // 소켓 매핑 제거
    const userSockets = this.userSockets.get(userId);
    if (userSockets) {
      userSockets.delete(ws);
      if (userSockets.size === 0) {
        this.userSockets.delete(userId);
        
        // Redis에서 온라인 상태 제거
        await redis.del(`user:online:${userId}`);
        await redis.srem(`server:${this.serverId}:users`, userId);

        // 다른 서버에 오프라인 상태 알림
        await redisPub.publish('user:offline', JSON.stringify({
          userId,
          serverId: this.serverId,
          timestamp: Date.now()
        }));

        // 친구들에게 오프라인 상태 알림
        await this.notifyFriendsAboutStatus(userId, false);
      }
    }
    this.socketUsers.delete(ws);
  }

  // 친구들의 온라인 상태 전송
  async sendFriendsStatus(userId) {
    try {
      // 친구 목록 조회 (캐싱된 데이터 사용)
      const friends = await this.getUserFriends(userId);
      const friendsStatus = [];

      // 배치로 친구들의 온라인 상태 확인
      const pipeline = redis.pipeline();
      friends.forEach(friendId => {
        pipeline.exists(`user:online:${friendId}`);
      });
      const results = await pipeline.exec();

      friends.forEach((friendId, index) => {
        friendsStatus.push({
          friendId,
          online: results[index][1] === 1
        });
      });

      this.sendToUser(userId, {
        type: 'friends_status',
        friends: friendsStatus
      });
    } catch (error) {
      console.error('Error sending friends status:', error);
    }
  }

  // 친구들에게 상태 변경 알림
  async notifyFriendsAboutStatus(userId, isOnline) {
    try {
      const friends = await this.getUserFriends(userId);
      const message = {
        type: 'friend_status',
        friendId: userId,
        online: isOnline
      };

      // 배치로 친구들에게 메시지 전송
      const promises = friends.map(friendId => 
        this.sendToUser(friendId, message)
      );
      
      await Promise.all(promises);
    } catch (error) {
      console.error('Error notifying friends:', error);
    }
  }

  // 특정 사용자에게 메시지 전송
  async sendToUser(userId, message) {
    const userSockets = this.userSockets.get(userId);
    if (userSockets && userSockets.size > 0) {
      // 로컬 소켓이 있는 경우
      const messageStr = JSON.stringify(message);
      userSockets.forEach(ws => {
        if (ws.readyState === ws.OPEN) {
          ws.send(messageStr);
        }
      });
    } else {
      // 다른 서버에 있는 사용자인지 확인하고 Redis Pub/Sub으로 전달
      const isOnline = await this.isUserOnline(userId);
      if (isOnline) {
        await redisPub.publish(`user:message:${userId}`, JSON.stringify(message));
      }
    }
  }

  // 사용자 온라인 상태 확인
  async isUserOnline(userId) {
    try {
      const result = await redis.exists(`user:online:${userId}`);
      return result === 1;
    } catch (error) {
      console.error('Error checking user online status:', error);
      return false;
    }
  }

  // 사용자 친구 목록 조회 (캐싱)
  async getUserFriends(userId) {
    const cacheKey = `friends:${userId}`;
    
    try {
      // Redis에서 캐싱된 친구 목록 확인
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // DB에서 친구 목록 조회 (실제 구현에서는 DB 쿼리)
      const friends = await this.fetchFriendsFromDB(userId);
      
      // 1시간 캐싱
      await redis.setex(cacheKey, 3600, JSON.stringify(friends));
      
      return friends;
    } catch (error) {
      console.error('Error getting user friends:', error);
      return [];
    }
  }

  // DB에서 친구 목록 조회 (Mock)
  async fetchFriendsFromDB(userId) {
    // 실제 구현에서는 데이터베이스 쿼리
    // 예: SELECT friend_id FROM friendships WHERE user_id = ? AND status = 'accepted'
    return []; // Mock data
  }

  // 토큰 검증 (Mock)
  async validateToken(userId, token) {
    // 실제 구현에서는 JWT 검증 또는 세션 검증
    return true; // Mock validation
  }

  // 하트비트 처리 (사용자 온라인 상태 갱신)
  async refreshUserOnlineStatus(userId) {
    await redis.setex(`user:online:${userId}`, 30, this.serverId);
  }

  // 서버 시작
  listen(port) {
    this.app.listen(port, (token) => {
      if (token) {
        console.log(`Server listening on port ${port}`);
      } else {
        console.log(`Failed to listen on port ${port}`);
        process.exit(1);
      }
    });

    // 주기적으로 연결된 사용자들의 온라인 상태 갱신
    setInterval(async () => {
      const users = Array.from(this.userSockets.keys());
      if (users.length > 0) {
        const pipeline = redis.pipeline();
        users.forEach(userId => {
          pipeline.setex(`user:online:${userId}`, 30, this.serverId);
        });
        await pipeline.exec();
      }
    }, 15000); // 15초마다 갱신
  }
}

// 클러스터 모드 실행
if (cluster.isMaster) {
  const numCPUs = os.cpus().length;
  console.log(`Master ${process.pid} is running`);

  // 워커 프로세스 생성
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ SERVER_ID: `server-${i}` });
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  // 워커 프로세스
  const manager = new FriendOnlineStatusManager();
  manager.initializeWebSocketServer();
  const port = process.env.PORT || (5555 + cluster.worker.id);
  manager.listen(port);
  
  console.log(`Worker ${process.pid} started`);
}

// 우아한 종료 처리
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  // Redis 연결 정리
  await redis.quit();
  await redisPub.quit();
  await redisSub.quit();
  
  process.exit(0);
});

module.exports = FriendOnlineStatusManager;