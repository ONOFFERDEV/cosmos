#!/usr/bin/env bash
# 로컬 data/out, models 디렉토리를 Rocky 서버의 도커 named volume(cosmos-data,
# cosmos-models)로 동기화한다. 컴포즈 스택이 먼저 떠 있지 않아도 동작하지만
# (docker run -v는 볼륨을 자동 생성한다), 깨끗한 최초 설치는 deploy.sh를 먼저
# 실행하는 것을 권장한다.
#
# 사용법: ./sync_data.sh [remote_host] [remote_dir]
set -euo pipefail

REMOTE_HOST="${1:-rocky}"
REMOTE_DIR="${2:-~/cosmos}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DATA_OUT="${REPO_ROOT}/data/out"
MODELS_DIR="${REPO_ROOT}/models"

sync_dir_to_volume() {
  local local_dir="$1"
  local volume_name="$2"

  if [[ ! -d "${local_dir}" ]]; then
    echo "경고: ${local_dir} 디렉토리가 없어 건너뜁니다 (${volume_name})."
    return
  fi

  echo "==> ${local_dir} -> ${REMOTE_HOST}:${volume_name}"
  tar -czf - -C "${local_dir}" . |
    ssh "${REMOTE_HOST}" "docker run --rm -i -v ${volume_name}:/data alpine sh -c 'tar -xzf - -C /data'"
}

sync_dir_to_volume "${DATA_OUT}" "cosmos-data"
sync_dir_to_volume "${MODELS_DIR}" "cosmos-models"

echo "==> 데이터 동기화 완료."
echo "    core 서비스가 이미 실행 중이라면 반영을 위해 재시작하세요:"
echo "    ssh ${REMOTE_HOST} 'cd ${REMOTE_DIR} && docker compose restart core'"
