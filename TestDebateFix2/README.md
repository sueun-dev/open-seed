# Shape Survivor

브라우저에서 실행되는 2D 아케이드 회피 게임입니다. 키보드로 플레이어를 움직여 점점 빨라지는 위험체를 피하세요.

## 실행

```bash
npm install
npm start
```

기본 주소: `http://127.0.0.1:3000`

## 스크립트

- `npm start`: 정적 서버 실행
- `npm run build`: TypeScript 컴파일
- `npm run lint`: TypeScript 타입 검사
- `npm test`: Node 테스트 실행

## 조작

- 이동: `WASD` 또는 방향키
- 재시작: `Enter` 또는 `Space`

## 게임 개요

- 플레이어는 초록색 사각형입니다.
- 위험체는 붉은 원 형태로 화면 바깥에서 진입합니다.
- 생존 시간이 점수이며 시간이 지날수록 스폰 빈도와 속도가 증가합니다.

## CI/CD 변경 및 롤백

### 권장 파이프라인 단계

1. `install`
2. `lint`
3. `build`
4. `smoke-test`

### 권장 체크

- `npm ci`
- `npm run lint`
- `npm run build`
- `npm test`
- 앱 기동 후 `http://127.0.0.1:3000` 에서 `<canvas>` 포함 여부 확인

### 롤백 절차

- 파이프라인 추가 실패 시: 워크플로 파일을 되돌리고 이전 필수 체크 구성을 복원합니다.
- 캐시 문제 시: 캐시 설정만 먼저 제거하고 재실행합니다.
- 릴리스 게이트 오작동 시: 마지막 정상 아티팩트/커밋으로 되돌린 뒤 게이트 변경을 revert 합니다.
