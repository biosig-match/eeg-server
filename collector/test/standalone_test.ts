import amqp from 'amqplib';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

// --- 設定 (Configuration) ---
const COLLECTOR_BASE_URL = 'http://localhost:3000'; // docker-compose.ymlで設定したポート
const RABBITMQ_URL = 'amqp://guest:guest@localhost:5672'; // docker-compose.ymlで設定したポート

// --- テストデータ (Test Data) ---
const TEST_USER_ID = 'test-user-001';
const TEST_SESSION_ID = `${TEST_USER_ID}-${Date.now()}`;
const DUMMY_IMAGE_PATH = path.join(__dirname, 'dummy_image.jpg');

// --- メイン実行関数 (Main Runner) ---
async function runTests() {
  let connection: amqp.Connection | null = null;
  let channel: amqp.Channel | null = null;
  let hasFailed = false;

  try {
    // --- セットアップ (Setup) ---
    console.log('--- Test Setup ---');

    // 1. ダミーの画像ファイルを作成
    if (!fs.existsSync(DUMMY_IMAGE_PATH)) {
      fs.writeFileSync(DUMMY_IMAGE_PATH, 'This is a dummy image file.');
      console.log(`✅ Created dummy image: ${DUMMY_IMAGE_PATH}`);
    }

    // 2. RabbitMQに接続し、コンシューマーを準備
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    console.log('✅ Connected to RabbitMQ.');

    await channel.assertExchange('raw_data_exchange', 'fanout', { durable: true });
    await channel.assertQueue('media_processing_queue', { durable: true });

    // --- テスト実行 (Run Tests) ---
    console.log('\n--- Running Tests ---');
    await testHealthCheck();
    await testSensorDataEndpoint(channel);
    await testMediaEndpoint(channel);
  } catch (error: any) {
    console.error('\n❌ Test execution failed:', error.message || error);
    hasFailed = true;
  } finally {
    // --- クリーンアップ (Cleanup) ---
    console.log('\n--- Test Cleanup ---');
    await channel?.close();
    await connection?.close();
    console.log('✅ Closed RabbitMQ connection.');

    if (hasFailed) {
      console.error('\n[RESULT] 🔥 At least one test failed.');
      process.exit(1);
    } else {
      console.log('\n[RESULT] ✅ All tests passed successfully!');
      process.exit(0);
    }
  }
}

// --- 個別テストケース (Test Cases) ---

async function testHealthCheck() {
  console.log('\n▶️  Testing GET /api/v1/health...');
  const response = await axios.get(`${COLLECTOR_BASE_URL}/api/v1/health`);
  if (response.status !== 200 || !response.data.rabbitmq_connected) {
    throw new Error(
      `Health check failed! Status: ${response.status}, RabbitMQ Connected: ${response.data.rabbitmq_connected}`,
    );
  }
  console.log('  ✅ Health check successful.');
}

async function testSensorDataEndpoint(channel: amqp.Channel) {
  console.log('\n▶️  Testing POST /api/v1/data...');
  const { queue } = await channel.assertQueue('', { exclusive: true }); // テスト用の一次キュー
  await channel.bindQueue(queue, 'raw_data_exchange', '');

  const dummyPayload = Buffer.from('dummy sensor data').toString('base64');

  // メッセージを待機するPromise
  const messageReceived = new Promise<amqp.ConsumeMessage>((resolve, reject) => {
    channel.consume(
      queue,
      (msg) => {
        if (msg) {
          resolve(msg);
        } else {
          reject(new Error('Received null message from RabbitMQ'));
        }
      },
      { noAck: true },
    );
    setTimeout(
      () => reject(new Error('Timeout: Did not receive message from raw_data_exchange')),
      5000,
    );
  });

  // APIを叩く
  await axios.post(`${COLLECTOR_BASE_URL}/api/v1/data`, {
    user_id: TEST_USER_ID,
    payload_base64: dummyPayload,
  });
  console.log('  - Sent request to /api/v1/data.');

  // メッセージ受信を待機して検証
  const receivedMsg = await messageReceived;
  console.log('  - Received message from RabbitMQ.');

  if (receivedMsg.content.toString() !== 'dummy sensor data') {
    throw new Error('Sensor data content mismatch.');
  }

  // ★★★ FIX: headersの存在をチェック ★★★
  const headers = receivedMsg.properties?.headers;
  if (!headers) {
    throw new Error('Received sensor data message is missing headers.');
  }

  if (headers.user_id !== TEST_USER_ID) {
    throw new Error(
      `Sensor data user_id mismatch. Expected ${TEST_USER_ID}, got ${headers.user_id}`,
    );
  }
  console.log('  ✅ Sensor data test successful.');
}

async function testMediaEndpoint(channel: amqp.Channel) {
  console.log('\n▶️  Testing POST /api/v1/media...');
  const queue = 'media_processing_queue';

  const messageReceived = new Promise<amqp.ConsumeMessage>((resolve, reject) => {
    channel.consume(
      queue,
      (msg) => {
        if (msg) {
          channel.ack(msg); // メッセージをキューから削除
          resolve(msg);
        } else {
          reject(new Error('Received null message from RabbitMQ'));
        }
      },
      { noAck: false },
    ); // 手動ACKモード
    setTimeout(
      () => reject(new Error('Timeout: Did not receive message from media_processing_queue')),
      5000,
    );
  });

  const form = new FormData();
  form.append('user_id', TEST_USER_ID);
  form.append('session_id', TEST_SESSION_ID);
  form.append('mimetype', 'image/jpeg');
  form.append('original_filename', 'dummy_image.jpg');
  form.append('timestamp_utc', new Date().toISOString());
  form.append('file', fs.createReadStream(DUMMY_IMAGE_PATH));

  await axios.post(`${COLLECTOR_BASE_URL}/api/v1/media`, form, { headers: form.getHeaders() });
  console.log('  - Sent request to /api/v1/media.');

  const receivedMsg = await messageReceived;
  console.log('  - Received message from RabbitMQ.');

  if (receivedMsg.content.toString() !== 'This is a dummy image file.') {
    throw new Error('Media data content mismatch.');
  }

  // ★★★ FIX: headersの存在をチェック ★★★
  const headers = receivedMsg.properties?.headers;
  if (!headers) {
    throw new Error('Received media message is missing headers.');
  }

  if (
    headers.user_id !== TEST_USER_ID ||
    headers.session_id !== TEST_SESSION_ID ||
    headers.mimetype !== 'image/jpeg'
  ) {
    throw new Error(`Media data headers mismatch. Got: ${JSON.stringify(headers)}`);
  }
  console.log('  ✅ Media data test successful.');
}

// スクリプト実行
runTests();
