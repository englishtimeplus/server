// client-example.js - 클라이언트 연결 예제
const WebSocket = require('ws');

class FriendStatusClient {
  constructor(serverUrl, userId, token) {
    this.serverUrl = serverUrl;
    this.userId = userId;
    this.token = token;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.heartbeatInterval = null;
    
    this.onFriendStatusChange = null;
    this.onFriendsListUpdate = null;
    this.onAuthSuccess = null;
    this.onAuthFailed = null;
  }

  connect() {
    try {
      this.ws = new WebSocket(this.serverUrl);
      
      this.ws.on('open', () => {
        console.log('Connected to server');
        this.reconnectAttempts = 0;
        this.authenticate();
        this.startHeartbeat();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`Connection closed: ${code} - ${reason}`);
        this.stopHeartbeat();
        this.reconnect();
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });

    } catch (error) {
      console.error('Failed to connect:', error);
      this.reconnect();
    }
  }

  authenticate() {
    this.send({
      type: 'auth',
      userId: this.userId,
      token: this.token
    });
  }

  handleMessage(message) {
    switch (message.type) {
      case 'auth_success':
        console.log('Authentication successful');
        if (this.onAuthSuccess) this.onAuthSuccess();
        this.requestFriendsStatus();
        break;

      case 'auth_failed':
        console.log('Authentication failed');
        if (this.onAuthFailed) this.onAuthFailed();
        break;

      case 'friend_status':
        console.log(`Friend ${message.friendId} is ${message.online ? 'online' : 'offline'}`);
        if (this.onFriendStatusChange) {
          this.onFriendStatusChange(message.friendId, message.online);
        }
        break;

      case 'friends_status':
        console.log('Received friends status:', message.friends);
        if (this.onFriendsListUpdate) {
          this.onFriendsListUpdate(message.friends);
        }
        break;

      case 'heartbeat_ack':
        // 하트비트 응답 처리
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket is not open. Message not sent:', data);
    }
  }

  requestFriendsStatus() {
    this.send({
      type: 'get_friends_status',
      userId: this.userId
    });
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, 25000); // 25초마다 하트비트
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      
      setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      console.error('Max reconnection attempts reached');
    }
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// 사용 예제
const client = new FriendStatusClient('ws://localhost:80', 'user123', 'jwt_token_here');

client.onAuthSuccess = () => {
  console.log('클라이언트가 성공적으로 인증되었습니다.');
};

client.onFriendStatusChange = (friendId, isOnline) => {
  console.log(`친구 ${friendId}가 ${isOnline ? '온라인' : '오프라인'} 상태입니다.`);
};

client.onFriendsListUpdate = (friends) => {
  console.log('친구 목록 업데이트:', friends);
  friends.forEach(friend => {
    console.log(`- ${friend.friendId}: ${friend.online ? '온라인' : '오프라인'}`);
  });
};

client.connect();

// 프로세스 종료 시 정리
process.on('SIGINT', () => {
  console.log('Disconnecting...');
  client.disconnect();
  process.exit(0);
});

module.exports = FriendStatusClient;

// ================================
// stress-test.js - 성능 테스트
// ================================

const WebSocket = require('ws');
const cluster = require('cluster');
const os = require('os');

class StressTest {
  constructor() {
    this.servers = [
      'ws://localhost:3001',
      'ws://localhost:3002', 
      'ws://localhost:3003'
    ];
    this.connections = [];
    this.metrics = {
      totalConnections: 0,
      successfulConnections: 0,
      failedConnections: 0,
      messagesReceived: 0,
      averageLatency: 0,
      startTime: Date.now()
    };
  }

  // 단일 연결 생성
  createConnection(userId, serverId = 0) {
    return new Promise((resolve, reject) => {
      const serverUrl = this.servers[serverId % this.servers.length];
      const ws = new WebSocket(serverUrl);
      const connectionStart = Date.now();

      ws.on('open', () => {
        const latency = Date.now() - connectionStart;
        this.metrics.successfulConnections++;
        
        // 인증
        ws.send(JSON.stringify({
          type: 'auth',
          userId: `test_user_${userId}`,
          token: 'test_token'
        }));

        ws.on('message', (data) => {
          this.metrics.messagesReceived++;
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'auth_success') {
              // 친구 상태 요청
              ws.send(JSON.stringify({
                type: 'get_friends_status',
                userId: `test_user_${userId}`
              }));
            }
          } catch (error) {
            console.error('Message parse error:', error);
          }
        });

        resolve({ ws, latency });
      });

      ws.on('error', (error) => {
        this.metrics.failedConnections++;
        reject(error);
      });

      // 타임아웃 설정
      setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  // 대량 연결 테스트
  async runConnectionTest(numberOfConnections, concurrency = 50) {
    console.log(`Starting connection test: ${numberOfConnections} connections with ${concurrency} concurrency`);
    
    const batches = Math.ceil(numberOfConnections / concurrency);
    const latencies = [];

    for (let batch = 0; batch < batches; batch++) {
      const batchPromises = [];
      const batchSize = Math.min(concurrency, numberOfConnections - batch * concurrency);

      for (let i = 0; i < batchSize; i++) {
        const userId = batch * concurrency + i;
        const serverId = userId % this.servers.length;
        
        batchPromises.push(
          this.createConnection(userId, serverId)
            .then(({ ws, latency }) => {
              this.connections.push(ws);
              latencies.push(latency);
              return { success: true, latency };
            })
            .catch(error => {
              console.error(`Connection ${userId} failed:`, error.message);
              return { success: false, error: error.message };
            })
        );
      }

      const batchResults = await Promise.all(batchPromises);
      
      console.log(`Batch ${batch + 1}/${batches} completed. Success: ${
        batchResults.filter(r => r.success).length
      }/${batchSize}`);

      // 배치 간 딜레이
      if (batch < batches - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // 메트릭스 계산
    this.metrics.totalConnections = numberOfConnections;
    this.metrics.averageLatency = latencies.length > 0 
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
      : 0;

    this.printResults();
  }

  // 메시지 처리량 테스트
  async runThroughputTest(duration = 60000) {
    console.log(`Starting throughput test for ${duration/1000} seconds`);
    
    const messageCount = {
      sent: 0,
      received: 0
    };

    // 각 연결에서 주기적으로 메시지 전송
    const intervals = this.connections.map(ws => {
      return setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'heartbeat',
            timestamp: Date.now()
          }));
          messageCount.sent++;
        }
      }, 1000);
    });

    // 메시지 수신 카운터
    this.connections.forEach(ws => {
      ws.on('message', () => {
        messageCount.received++;
      });
    });

    // 테스트 실행
    await new Promise(resolve => setTimeout(resolve, duration));

    // 정리
    intervals.forEach(interval => clearInterval(interval));

    console.log('\n=== Throughput Test Results ===');
    console.log(`Messages sent: ${messageCount.sent}`);
    console.log(`Messages received: ${messageCount.received}`);
    console.log(`Messages per second (sent): ${(messageCount.sent / (duration / 1000)).toFixed(2)}`);
    console.log(`Messages per second (received): ${(messageCount.received / (duration / 1000)).toFixed(2)}`);
    console.log(`Success rate: ${((messageCount.received / messageCount.sent) * 100).toFixed(2)}%`);
  }

  // 메모리 사용량 테스트
  async runMemoryTest() {
    console.log('Starting memory usage monitoring...');
    
    const initialMemory = process.memoryUsage();
    console.log('Initial memory usage:', this.formatMemory(initialMemory));

    // 10초 간격으로 메모리 사용량 체크
    const memoryInterval = setInterval(() => {
      const currentMemory = process.memoryUsage();
      const memoryDiff = {
        rss: currentMemory.rss - initialMemory.rss,
        heapUsed: currentMemory.heapUsed - initialMemory.heapUsed,
        heapTotal: currentMemory.heapTotal - initialMemory.heapTotal,
        external: currentMemory.external - initialMemory.external
      };

      console.log(`Memory usage - Active connections: ${this.connections.length}`);
      console.log(`  Current:`, this.formatMemory(currentMemory));
      console.log(`  Diff from start:`, this.formatMemory(memoryDiff));
      console.log('---');
    }, 10000);

    return memoryInterval;
  }

  formatMemory(mem) {
    return {
      rss: `${Math.round(mem.rss / 1024 / 1024 * 100) / 100} MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100} MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100} MB`,
      external: `${Math.round(mem.external / 1024 / 1024 * 100) / 100} MB`
    };
  }

  printResults() {
    const duration = (Date.now() - this.metrics.startTime) / 1000;
    
    console.log('\n=== Stress Test Results ===');
    console.log(`Test duration: ${duration.toFixed(2)} seconds`);
    console.log(`Total connections attempted: ${this.metrics.totalConnections}`);
    console.log(`Successful connections: ${this.metrics.successfulConnections}`);
    console.log(`Failed connections: ${this.metrics.failedConnections}`);
    console.log(`Success rate: ${((this.metrics.successfulConnections / this.metrics.totalConnections) * 100).toFixed(2)}%`);
    console.log(`Average connection latency: ${this.metrics.averageLatency.toFixed(2)}ms`);
    console.log(`Messages received: ${this.metrics.messagesReceived}`);
    console.log(`Connections per second: ${(this.metrics.successfulConnections / duration).toFixed(2)}`);
    console.log('================================\n');
  }

  // 모든 연결 해제
  closeAllConnections() {
    console.log(`Closing ${this.connections.length} connections...`);
    
    this.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    
    this.connections = [];
  }

  // 연결 상태 모니터링
  monitorConnections() {
    setInterval(() => {
      const openConnections = this.connections.filter(
        ws => ws.readyState === WebSocket.OPEN
      ).length;
      
      console.log(`Active connections: ${openConnections}/${this.connections.length}`);
    }, 5000);
  }
}

// 클러스터 모드로 스트레스 테스트 실행
if (cluster.isMaster) {
  const numWorkers = os.cpus().length;
  const connectionsPerWorker = 250; // 워커당 연결 수
  
  console.log(`Starting stress test with ${numWorkers} workers`);
  console.log(`Total connections: ${numWorkers * connectionsPerWorker}`);

  // 워커 생성
  for (let i = 0; i < numWorkers; i++) {
    const worker = cluster.fork();
    worker.send({ 
      workerId: i, 
      connections: connectionsPerWorker,
      startDelay: i * 1000 // 1초씩 지연하여 시작
    });
  }

  // 워커 종료 처리
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
  });

  // 10분 후 모든 워커 종료
  setTimeout(() => {
    console.log('Shutting down all workers...');
    Object.values(cluster.workers).forEach(worker => {
      worker.kill();
    });
    process.exit(0);
  }, 600000);

} else {
  // 워커 프로세스
  process.on('message', async (msg) => {
    const { workerId, connections, startDelay } = msg;
    
    console.log(`Worker ${workerId} starting in ${startDelay}ms...`);
    
    setTimeout(async () => {
      const stressTest = new StressTest();
      
      try {
        // 메모리 모니터링 시작
        const memoryInterval = await stressTest.runMemoryTest();
        
        // 연결 상태 모니터링 시작
        stressTest.monitorConnections();
        
        // 대량 연결 테스트
        await stressTest.runConnectionTest(connections, 25);
        
        // 처리량 테스트 (30초)
        await stressTest.runThroughputTest(30000);
        
        // 메모리 모니터링 중지
        clearInterval(memoryInterval);
        
        console.log(`Worker ${workerId} completed tests`);
        
        // 연결 유지하여 장시간 테스트
        console.log(`Worker ${workerId} maintaining connections for extended test...`);
        
      } catch (error) {
        console.error(`Worker ${workerId} error:`, error);
        stressTest.closeAllConnections();
      }
    }, startDelay);
  });
}

// ================================
// load-test-config.js - 부하 테스트 설정
// ================================

const loadTestConfigs = {
  // 소규모 테스트 (개발 환경)
  small: {
    connections: 100,
    concurrency: 10,
    duration: 30000, // 30초
    messageRate: 1000 // 초당 메시지 수
  },
  
  // 중간 규모 테스트 (스테이징 환경)
  medium: {
    connections: 1000,
    concurrency: 50,
    duration: 300000, // 5분
    messageRate: 5000
  },
  
  // 대규모 테스트 (프로덕션 검증)
  large: {
    connections: 10000,
    concurrency: 100,
    duration: 1800000, // 30분
    messageRate: 10000
  },
  
  // 극한 테스트 (성능 한계 측정)
  extreme: {
    connections: 50000,
    concurrency: 200,
    duration: 3600000, // 1시간
    messageRate: 50000
  }
};

// 특정 시나리오별 테스트
const testScenarios = {
  // 친구가 많은 사용자 시나리오
  highFriendCount: {
    description: "친구 1000명 이상인 사용자들의 온라인 상태 동기화",
    setup: async (testInstance) => {
      // 사용자당 1000개의 친구 관계 생성
      for (let i = 0; i < 100; i++) {
        await testInstance.createUserWithManyFriends(`heavy_user_${i}`, 1000);
      }
    }
  },
  
  // 동시 접속 급증 시나리오
  suddenSpike: {
    description: "짧은 시간 내 대량 사용자 동시 접속",
    setup: async (testInstance) => {
      // 5초 내에 1000명 동시 접속
      const promises = [];
      for (let i = 0; i < 1000; i++) {
        promises.push(testInstance.createConnection(`spike_user_${i}`));
      }
      await Promise.all(promises);
    }
  },
  
  // 친구 상태 변경 폭증 시나리오
  massStatusChange: {
    description: "동시에 많은 사용자의 온라인/오프라인 상태 변경",
    execute: async (testInstance) => {
      // 연결된 사용자들을 랜덤하게 접속/해제
      setInterval(() => {
        const randomConnections = testInstance.connections
          .sort(() => 0.5 - Math.random())
          .slice(0, 100);
        
        randomConnections.forEach(ws => {
          if (Math.random() > 0.5) {
            ws.close();
          }
        });
      }, 5000);
    }
  }
};

// ================================
// monitoring.js - 실시간 모니터링
// ================================

class RealTimeMonitoring {
  constructor() {
    this.metrics = {
      connections: 0,
      messagesPerSecond: 0,
      errorRate: 0,
      memoryUsage: 0,
      redisLatency: 0,
      timestamp: Date.now()
    };
    
    this.alerts = [];
    this.thresholds = {
      maxConnections: 10000,
      maxErrorRate: 0.05, // 5%
      maxMemoryUsage: 1024 * 1024 * 1024, // 1GB
      maxRedisLatency: 100 // 100ms
    };
  }

  // 메트릭스 수집
  async collectMetrics() {
    const newMetrics = {
      connections: await this.getActiveConnections(),
      messagesPerSecond: await this.getMessagesPerSecond(),
      errorRate: await this.getErrorRate(),
      memoryUsage: process.memoryUsage().heapUsed,
      redisLatency: await this.measureRedisLatency(),
      timestamp: Date.now()
    };

    this.checkThresholds(newMetrics);
    this.metrics = newMetrics;
    
    return newMetrics;
  }

  // 임계값 확인 및 알림
  checkThresholds(metrics) {
    const alerts = [];

    if (metrics.connections > this.thresholds.maxConnections) {
      alerts.push({
        type: 'HIGH_CONNECTION_COUNT',
        message: `Connection count (${metrics.connections}) exceeds threshold (${this.thresholds.maxConnections})`,
        severity: 'WARNING'
      });
    }

    if (metrics.errorRate > this.thresholds.maxErrorRate) {
      alerts.push({
        type: 'HIGH_ERROR_RATE',
        message: `Error rate (${(metrics.errorRate * 100).toFixed(2)}%) exceeds threshold (${(this.thresholds.maxErrorRate * 100).toFixed(2)}%)`,
        severity: 'CRITICAL'
      });
    }

    if (metrics.memoryUsage > this.thresholds.maxMemoryUsage) {
      alerts.push({
        type: 'HIGH_MEMORY_USAGE',
        message: `Memory usage (${Math.round(metrics.memoryUsage / 1024 / 1024)}MB) exceeds threshold (${Math.round(this.thresholds.maxMemoryUsage / 1024 / 1024)}MB)`,
        severity: 'WARNING'
      });
    }

    if (metrics.redisLatency > this.thresholds.maxRedisLatency) {
      alerts.push({
        type: 'HIGH_REDIS_LATENCY',
        message: `Redis latency (${metrics.redisLatency}ms) exceeds threshold (${this.thresholds.maxRedisLatency}ms)`,
        severity: 'WARNING'
      });
    }

    // 새로운 알림 처리
    alerts.forEach(alert => {
      console.warn(`🚨 ALERT [${alert.severity}]: ${alert.message}`);
      this.alerts.push({
        ...alert,
        timestamp: Date.now()
      });
    });
  }

  // 활성 연결 수 조회
  async getActiveConnections() {
    // 실제 구현에서는 Redis에서 조회
    return Math.floor(Math.random() * 5000);
  }

  // 초당 메시지 수 계산
  async getMessagesPerSecond() {
    // 실제 구현에서는 Redis counter에서 계산
    return Math.floor(Math.random() * 1000);
  }

  // 에러율 계산
  async getErrorRate() {
    // 실제 구현에서는 에러 로그 분석
    return Math.random() * 0.1;
  }

  // Redis 지연시간 측정
  async measureRedisLatency() {
    // 실제 구현에서는 Redis ping 측정
    return Math.floor(Math.random() * 50);
  }

  // 대시보드 출력
  printDashboard() {
    console.clear();
    console.log('='.repeat(80));
    console.log('🚀 FRIEND STATUS SYSTEM - REAL-TIME MONITORING');
    console.log('='.repeat(80));
    console.log(`📊 Active Connections: ${this.metrics.connections.toLocaleString()}`);
    console.log(`📈 Messages/sec: ${this.metrics.messagesPerSecond.toLocaleString()}`);
    console.log(`⚠️  Error Rate: ${(this.metrics.errorRate * 100).toFixed(2)}%`);
    console.log(`💾 Memory Usage: ${Math.round(this.metrics.memoryUsage / 1024 / 1024)}MB`);
    console.log(`🔗 Redis Latency: ${this.metrics.redisLatency}ms`);
    console.log(`🕒 Last Update: ${new Date(this.metrics.timestamp).toLocaleTimeString()}`);
    
    if (this.alerts.length > 0) {
      console.log('\n🚨 RECENT ALERTS:');
      this.alerts.slice(-5).forEach(alert => {
        console.log(`  [${alert.severity}] ${alert.message}`);
      });
    }
    
    console.log('='.repeat(80));
  }

  // 모니터링 시작
  start(interval = 5000) {
    console.log('Starting real-time monitoring...');
    
    setInterval(async () => {
      await this.collectMetrics();
      this.printDashboard();
    }, interval);
  }
}

// 사용 예제
if (require.main === module) {
  const testConfig = process.argv[2] || 'small';
  const config = loadTestConfigs[testConfig];
  
  if (!config) {
    console.error(`Unknown test config: ${testConfig}`);
    console.log('Available configs:', Object.keys(loadTestConfigs));
    process.exit(1);
  }

  console.log(`Starting ${testConfig} load test...`);
  console.log('Config:', config);

  const stressTest = new StressTest();
  const monitoring = new RealTimeMonitoring();

  // 모니터링 시작
  monitoring.start();

  // 테스트 실행
  stressTest.runConnectionTest(config.connections, config.concurrency)
    .then(() => stressTest.runThroughputTest(config.duration))
    .catch(console.error);
}

module.exports = {
  StressTest,
  loadTestConfigs,
  testScenarios,
  RealTimeMonitoring
};