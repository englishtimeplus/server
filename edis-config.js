// redis-config.js - Redis 최적화 설정
const Redis = require('ioredis');

class RedisConnectionManager {
  constructor() {
    this.connections = new Map();
    this.initializeConnections();
  }

  initializeConnections() {
    // 메인 Redis 클러스터 (읽기/쓰기)
    this.connections.set('main', new Redis.Cluster([
      { host: 'redis-node-1', port: 6379 },
      { host: 'redis-node-2', port: 6379 },
      { host: 'redis-node-3', port: 6379 },
      { host: 'redis-node-4', port: 6379 },
      { host: 'redis-node-5', port: 6379 },
      { host: 'redis-node-6', port: 6379 }
    ], {
      enableOfflineQueue: false,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      scaleReads: 'slave', // 읽기는 슬레이브에서
      enableReadyCheck: true,
      lazyConnect: true,
      keepAlive: 30000,
      connectTimeout: 10000,
      commandTimeout: 5000,
      // 연결 풀 설정
      family: 4,
      keyPrefix: 'friends:',
      // 클러스터 설정
      enableOfflineQueue: false,
      redisOptions: {
        // 각 노드별 연결 설정
        connectTimeout: 5000,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        // 메모리 최적화
        compression: 'gzip',
        // 네트워크 최적화
        keepAlive: true,
        noDelay: true
      }
    }));

    // Pub/Sub 전용 연결 (별도 연결로 블로킹 방지)
    this.connections.set('pub', this.connections.get('main').duplicate());
    this.connections.set('sub', this.connections.get('main').duplicate());

    // 캐싱 전용 연결 (친구 목록, 프로필 등)
    this.connections.set('cache', this.connections.get('main').duplicate());

    // 세션 관리 전용 연결
    this.connections.set('session', this.connections.get('main').duplicate());
  }

  getConnection(type = 'main') {
    return this.connections.get(type);
  }

  async closeAll() {
    const promises = Array.from(this.connections.values()).map(conn => conn.quit());
    await Promise.all(promises);
  }
}

// Redis 키 설계 및 최적화
class RedisKeyManager {
  static getKeys() {
    return {
      // 온라인 상태 (TTL: 30초)
      userOnline: (userId) => `online:${userId}`,
      
      // 서버별 사용자 목록 (Set)
      serverUsers: (serverId) => `server:${serverId}:users`,
      
      // 친구 목록 캐시 (TTL: 1시간)
      friendsList: (userId) => `friends:${userId}`,
      
      // 친구 관계 양방향 Set
      userFriends: (userId) => `user:${userId}:friends`,
      
      // 온라인 친구 카운트 (Sorted Set for ranking)
      onlineFriendsCount: (userId) => `online_count:${userId}`,
      
      // 사용자 세션 (Hash)
      userSession: (userId) => `session:${userId}`,
      
      // 친구 요청 대기열 (List)
      friendRequests: (userId) => `requests:${userId}`,
      
      // 사용자 프로필 캐시 (Hash, TTL: 10분)
      userProfile: (userId) => `profile:${userId}`,
      
      // 최근 활동 시간 (Sorted Set)
      lastActivity: () => 'activity:last_seen',
      
      // 서버 상태 모니터링
      serverHealth: (serverId) => `health:${serverId}`,
      
      // Rate limiting
      rateLimitUser: (userId) => `limit:user:${userId}`,
      rateLimitIP: (ip) => `limit:ip:${ip.replace(/\./g, ':')}`
    };
  }
}

// 배치 처리 최적화
class RedisBatchProcessor {
  constructor(redisManager) {
    this.redis = redisManager.getConnection('main');
    this.batchSize = 100;
    this.batchTimeout = 50; // ms
    this.pendingOperations = new Map();
  }

  // 배치로 온라인 상태 확인
  async checkMultipleUserStatus(userIds) {
    if (userIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    const keys = RedisKeyManager.getKeys();
    
    userIds.forEach(userId => {
      pipeline.exists(keys.userOnline(userId));
    });

    const results = await pipeline.exec();
    return userIds.map((userId, index) => ({
      userId,
      online: results[index][1] === 1
    }));
  }

  // 배치로 친구 목록 조회
  async getFriendsListBatch(userIds) {
    const pipeline = this.redis.pipeline();
    const keys = RedisKeyManager.getKeys();
    
    userIds.forEach(userId => {
      pipeline.smembers(keys.userFriends(userId));
    });

    const results = await pipeline.exec();
    return userIds.reduce((acc, userId, index) => {
      acc[userId] = results[index][1] || [];
      return acc;
    }, {});
  }

  // 배치로 사용자 온라인 상태 갱신
  async refreshMultipleUserStatus(userStatusMap) {
    const pipeline = this.redis.pipeline();
    const keys = RedisKeyManager.getKeys();
    
    Object.entries(userStatusMap).forEach(([userId, serverId]) => {
      pipeline.setex(keys.userOnline(userId), 30, serverId);
    });

    await pipeline.exec();
  }
}

// 고성능 친구 상태 관리자
class OptimizedFriendStatusManager {
  constructor() {
    this.redisManager = new RedisConnectionManager();
    this.batchProcessor = new RedisBatchProcessor(this.redisManager);
    this.keys = RedisKeyManager.getKeys();
    
    // 메모리 캐시 (로컬 캐싱으로 Redis 부하 감소)
    this.localCache = new Map();
    this.cacheTimeout = 5000; // 5초 로컬 캐시
    
    this.initializeOptimizations();
  }

  initializeOptimizations() {
    // 로컬 캐시 정리
    setInterval(() => {
      const now = Date.now();
      for (const [key, data] of this.localCache.entries()) {
        if (now - data.timestamp > this.cacheTimeout) {
          this.localCache.delete(key);
        }
      }
    }, 10000); // 10초마다 캐시 정리

    // Redis 연결 상태 모니터링
    this.monitorRedisHealth();
  }

  // Redis 연결 상태 모니터링
  monitorRedisHealth() {
    setInterval(async () => {
      try {
        const redis = this.redisManager.getConnection('main');
        const start = Date.now();
        await redis.ping();
        const latency = Date.now() - start;
        
        console.log(`Redis latency: ${latency}ms`);
        
        if (latency > 100) {
          console.warn('High Redis latency detected');
        }
      } catch (error) {
        console.error('Redis health check failed:', error);
      }
    }, 30000);
  }

  // 캐시된 친구 목록 조회
  async getFriendsList(userId) {
    const cacheKey = `friends:${userId}`;
    
    // 로컬 캐시 확인
    const cached = this.localCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    // Redis 캐시 확인
    const redis = this.redisManager.getConnection('cache');
    const redisData = await redis.get(this.keys.friendsList(userId));
    
    if (redisData) {
      const friends = JSON.parse(redisData);
      this.localCache.set(cacheKey, {
        data: friends,
        timestamp: Date.now()
      });
      return friends;
    }

    // DB에서 조회 후 캐싱
    const friends = await this.fetchFriendsFromDB(userId);
    
    // Redis에 1시간 캐싱
    await redis.setex(this.keys.friendsList(userId), 3600, JSON.stringify(friends));
    
    // 로컬 캐싱
    this.localCache.set(cacheKey, {
      data: friends,
      timestamp: Date.now()
    });
    
    return friends;
  }

  // 대량 사용자 온라인 상태 확인 (친구가 많은 사용자 대응)
  async getMassiveFriendsStatus(userId) {
    const friends = await this.getFriendsList(userId);
    
    if (friends.length === 0) return [];

    // 친구가 1000명 이상인 경우 청크 단위로 처리
    if (friends.length > 1000) {
      return await this.processLargeFriendsList(friends);
    }

    // 일반적인 경우 배치 처리
    return await this.batchProcessor.checkMultipleUserStatus(friends);
  }

  // 대용량 친구 목록 처리
  async processLargeFriendsList(friends) {
    const chunkSize = 500;
    const chunks = [];
    
    for (let i = 0; i < friends.length; i += chunkSize) {
      chunks.push(friends.slice(i, i + chunkSize));
    }

    const results = await Promise.all(
      chunks.map(chunk => this.batchProcessor.checkMultipleUserStatus(chunk))
    );

    return results.flat();
  }

  // Rate limiting (Redis 기반)
  async checkRateLimit(userId, action, limit = 100, window = 60) {
    const redis = this.redisManager.getConnection('main');
    const key = `${this.keys.rateLimitUser(userId)}:${action}`;
    
    const current = await redis.incr(key);
    
    if (current === 1) {
      await redis.expire(key, window);
    }
    
    return current <= limit;
  }

  // 친구 관계 변경 시 캐시 무효화
  async invalidateFriendCache(userId, friendId) {
    const redis = this.redisManager.getConnection('cache');
    
    // Redis 캐시 삭제
    await Promise.all([
      redis.del(this.keys.friendsList(userId)),
      redis.del(this.keys.friendsList(friendId))
    ]);

    // 로컬 캐시 삭제
    this.localCache.delete(`friends:${userId}`);
    this.localCache.delete(`friends:${friendId}`);
  }

  // 데이터베이스에서 친구 목록 조회 (Mock)
  async fetchFriendsFromDB(userId) {
    // 실제 구현에서는 최적화된 DB 쿼리
    // WITH 인덱스 힌트 사용, 페이지네이션 등
    return [];
  }

  // 서버 종료 시 정리
  async cleanup() {
    await this.redisManager.closeAll();
    this.localCache.clear();
  }
}

// 모니터링 및 메트릭스
class FriendStatusMetrics {
  constructor(redisManager) {
    this.redis = redisManager.getConnection('main');
    this.metrics = {
      onlineUsers: 0,
      totalConnections: 0,
      messagesPerSecond: 0,
      redisLatency: 0
    };
  }

  // 실시간 메트릭스 수집
  async collectMetrics() {
    const pipeline = this.redis.pipeline();
    
    // 온라인 사용자 수
    pipeline.eval(`
      local count = 0
      local keys = redis.call('keys', 'friends:online:*')
      return #keys
    `, 0);

    const results = await pipeline.exec();
    this.metrics.onlineUsers = results[0][1];
    
    return this.metrics;
  }

  // 메트릭스 로깅
  startMetricsLogging() {
    setInterval(async () => {
      const metrics = await this.collectMetrics();
      console.log('Metrics:', JSON.stringify(metrics, null, 2));
    }, 60000); // 1분마다
  }
}

module.exports = {
  RedisConnectionManager,
  RedisKeyManager,
  RedisBatchProcessor,
  OptimizedFriendStatusManager,
  FriendStatusMetrics
};