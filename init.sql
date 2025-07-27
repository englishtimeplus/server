CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 사용자 테이블
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 친구 관계 테이블
CREATE TABLE friendships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending', -- pending, accepted, blocked
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
);

-- 인덱스 생성 (성능 최적화)
CREATE INDEX idx_friendships_user_id ON friendships(user_id);
CREATE INDEX idx_friendships_friend_id ON friendships(friend_id);
CREATE INDEX idx_friendships_status ON friendships(status);
CREATE INDEX idx_friendships_user_status ON friendships(user_id, status);

-- 친구 관계는 양방향이므로 트리거로 자동 생성
CREATE OR REPLACE FUNCTION create_mutual_friendship()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'accepted' THEN
        INSERT INTO friendships (user_id, friend_id, status, created_at, updated_at)
        VALUES (NEW.friend_id, NEW.user_id, 'accepted', NOW(), NOW())
        ON CONFLICT (user_id, friend_id) DO UPDATE SET
            status = 'accepted',
            updated_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_mutual_friendship
    AFTER INSERT OR UPDATE ON friendships
    FOR EACH ROW
    EXECUTE FUNCTION create_mutual_friendship();

-- 샘플 데이터 (테스트용)
INSERT INTO users (username, email, password_hash) VALUES
('user1', 'user1@example.com', '$2a$10$sample_hash_1'),
('user2', 'user2@example.com', '$2a$10$sample_hash_2'),
('user3', 'user3@example.com', '$2a$10$sample_hash_3');