# Cosmos 배포 (Docker / Rocky)

`core`(Rust, 검색 엔진) + `mind`(Node, LLM 오케스트레이션) 2개 컨테이너를
`docker compose`로 묶어 배포한다. 빌드 컨텍스트는 항상 레포 루트(`..`)다.

```
deploy/
  Dockerfile.core       core 이미지
  Dockerfile.mind       mind 이미지
  docker-compose.yml    두 서비스 + 볼륨 정의
  .env.example          COSMOS_TOKEN 예시
  deploy.sh             PC -> Rocky 배포 스크립트
  sync_data.sh          로컬 data/out, models -> Rocky 볼륨 동기화
```

## 최초 배포

1. PC에서 Rocky로 전송 + 빌드 + 기동:

   ```bash
   ./deploy.sh [remote_host] [remote_dir]
   # 예: ./deploy.sh rocky ~/cosmos
   # remote_host는 SSH config의 별칭(예: rocky) 또는 user@192.168.0.34 형태.
   # 생략하면 기본값 rocky / ~/cosmos 사용.
   ```

   `deploy.sh`는 `git archive`로 커밋된 내용만 전송하므로, 배포 전에 필요한
   변경사항을 커밋해 둔다. 원격에 `deploy/.env`가 없으면 `.env.example`에서
   자동 생성되는데, **토큰이 기본값(`바꿔주세요`)이므로 최초 1회는 직접
   접속해서 실제 값으로 채워야 한다**:

   ```bash
   ssh rocky "vi ~/cosmos/deploy/.env"
   ssh rocky "cd ~/cosmos && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d"
   ```

2. 기존 검색 인덱스/모델 데이터가 있다면 이관:

   ```bash
   ./sync_data.sh [remote_host] [remote_dir]
   ```

   로컬 `data/out` -> `cosmos-data` 볼륨, 로컬 `models` -> `cosmos-models`
   볼륨으로 tar 스트리밍 전송한다. 컴포즈 스택이 아직 안 떠 있어도 볼륨은
   자동 생성되지만, 되도록 `deploy.sh`를 먼저 실행해 둔 뒤에 돌리는 것을
   권장한다.

3. LLM 키: `deploy/.env`의 `ANTHROPIC_API_KEY` 설정(내부 대안 백엔드는 `COSMOS_LLM`으로 지정).

4. 확인:

   ```bash
   curl http://<rocky-ip>:8800/
   ```

## 재배포 / 업데이트

로컬에서 변경사항을 커밋한 뒤 다시 `./deploy.sh`를 실행하면 된다. 내부적으로
전송 -> `docker compose build` -> `up -d` -> 헬스체크 순으로 진행되며, 이미지
이름(`cosmos-core:latest`, `cosmos-mind:latest`)이 갱신될 뿐 볼륨 데이터는
그대로 유지된다.

## 로그 보기

```bash
ssh rocky "cd ~/cosmos && docker compose -f deploy/docker-compose.yml logs -f"
ssh rocky "cd ~/cosmos && docker compose -f deploy/docker-compose.yml logs -f mind"
ssh rocky "cd ~/cosmos && docker compose -f deploy/docker-compose.yml logs -f core"
```

## 롤백

`deploy.sh`는 매번 `latest` 태그를 덮어쓰므로, 롤백이 필요할 경우를 대비해
배포 전 현재 이미지를 태그해 두는 것을 권장한다:

```bash
ssh rocky "docker tag cosmos-core:latest cosmos-core:rollback"
ssh rocky "docker tag cosmos-mind:latest cosmos-mind:rollback"
```

문제가 생기면 `docker-compose.yml`의 `image:` 값을 일시적으로
`cosmos-core:rollback` / `cosmos-mind:rollback`으로 바꾸고
`docker compose up -d`를 다시 실행하거나, 다음처럼 직접 재태그 후 재기동한다:

```bash
ssh rocky "docker tag cosmos-core:rollback cosmos-core:latest"
ssh rocky "docker tag cosmos-mind:rollback cosmos-mind:latest"
ssh rocky "cd ~/cosmos && docker compose -f deploy/docker-compose.yml up -d --force-recreate"
```

데이터(볼륨)는 이미지 롤백과 무관하게 그대로 유지된다.

## 참고

- `core`는 내부망에만 노출된다(`expose: 8801`). 외부에서 직접 접근할 수
  없고 `mind`가 `http://core:8801`로만 접근한다.
- `mind`는 호스트 `8800` 포트로 노출된다.
- `COSMOS_TOKEN`은 `.env` 파일로 주입한다(`.env.example` 참고).
