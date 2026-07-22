#!/usr/bin/env bash
# PC에서 Rocky 서버로 cosmos를 배포한다.
# ① git archive(커밋된 것만) 전송 ② docker compose build ③ compose up -d
# ④ 헬스체크. 데이터(data/out, models) 이관은 sync_data.sh를 따로 사용한다.
#
# 사용법: ./deploy.sh [remote_host] [remote_dir]
set -euo pipefail

REMOTE_HOST="${1:-rocky}"
REMOTE_DIR="${2:-~/cosmos}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARCHIVE="$(mktemp -t cosmos-deploy-XXXXXX.tar)"
trap 'rm -f "${ARCHIVE}"' EXIT

echo "==> ① 커밋된 스냅샷(git archive) 생성"
(cd "${REPO_ROOT}" && git archive --format=tar -o "${ARCHIVE}" HEAD)

echo "==> 원격 디렉토리 준비: ${REMOTE_HOST}:${REMOTE_DIR}"
ssh "${REMOTE_HOST}" "mkdir -p '${REMOTE_DIR}'"

echo "==> 전송 중..."
scp "${ARCHIVE}" "${REMOTE_HOST}:${REMOTE_DIR}/deploy.tar"

echo "==> 원격에서 압축 해제"
ssh "${REMOTE_HOST}" "cd '${REMOTE_DIR}' && tar -xf deploy.tar && rm -f deploy.tar"

echo "==> deploy/.env 준비 (없으면 예시에서 생성 — 최초 배포 시 토큰을 직접 채워야 함)"
ssh "${REMOTE_HOST}" "cd '${REMOTE_DIR}' && [ -f deploy/.env ] || cp deploy/.env.example deploy/.env"

echo "==> ② docker compose build"
ssh "${REMOTE_HOST}" "cd '${REMOTE_DIR}' && docker compose -f deploy/docker-compose.yml --env-file deploy/.env build"

echo "==> ④ docker compose up -d"
ssh "${REMOTE_HOST}" "cd '${REMOTE_DIR}' && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d"

echo "==> ⑤ 헬스체크 (mind :8800)"
ok=0
for i in $(seq 1 10); do
  if ssh "${REMOTE_HOST}" "curl -fsS http://127.0.0.1:8800/ -o /dev/null"; then
    ok=1
    break
  fi
  sleep 3
done

if [[ "${ok}" -eq 1 ]]; then
  echo "==> 배포 완료: http://${REMOTE_HOST}:8800 정상 응답."
else
  echo "경고: 헬스체크 실패. 로그를 확인하세요:"
  echo "  ssh ${REMOTE_HOST} 'cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.yml logs --tail=100'"
  exit 1
fi

echo "참고: data/out, models 데이터 이관은 ./sync_data.sh 를 별도로 실행하세요."
