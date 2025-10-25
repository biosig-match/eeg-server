### テストの実行方法

1. プロジェクトルートでサービス群を起動

```
docker compose up --build
```

2. 移動

```
cd integration_test
```

3. 実行

```
bun test
```

> ヒント: テストをホスト環境から実行する場合は、事前に `docker compose up` で
> PostgreSQL や RabbitMQ などの依存サービスを起動してください。
> もし Docker ネットワーク内ホスト名（例: `db`, `rabbitmq`）を利用したい場合は、
> `TEST_USE_DOCKER_HOSTNAMES=true bun test` のように実行すると、従来どおりのホスト名を
> 使用できます。
> PostgreSQL の起動には 1〜2 分かかる場合があります。`bun test` が接続待ちで失敗した場合も、
> しばらく待ってから再度実行してください。
