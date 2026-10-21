# 랜딩 헬스체크 (Landing Page Health Check)

광고주명만 넣으면 **Meta · Google · Naver** 에서 집행 중인 소재를 찾아 랜딩 URL을 주기적으로 점검합니다.
API 연동 없이 각 매체의 **공개 광고 라이브러리를 크롤링**합니다.

| 점검 항목 | 판정 | 제안 |
|---|---|---|
| 404 / 410 / 5xx / 접속 실패 | 🔴 critical | OFF/랜딩 수정 |
| 페이지 없음·판매종료 문구 (소프트 404) | 🔴 critical | OFF/랜딩 수정 |
| **상품 직랜딩** 품절 (JSON-LD·메타태그·스마트스토어 상태값, 또는 '품절' 표시 + 구매버튼 없음) | 🔴 critical | OFF/랜딩 수정 |
| 상품 직랜딩의 일부 옵션 품절 (구매 버튼은 살아 있음) | 🟡 warn | 점검 필요 |
| 가격 변경 (직전 점검 대비, 상품 직랜딩만) | 🟡 warn | 점검 필요 |
| 광고 문구 가격 ≠ 랜딩 가격 | 🟡 warn | 점검 필요 |
| UTM 누락 (`utm_source`/`utm_medium`/`utm_campaign`) | 🟡 warn | 점검 필요 |
| 상품 URL → 메인 페이지 리다이렉트 | 🟡 warn | 점검 필요 |
| 봇 차단 등으로 확인 불가 | ⚪ info | 수동 확인 |

**랜딩 유형 구분**: URL 패턴·`og:type`·JSON-LD·상품 링크 수로 `상품 직랜딩` / `기획전·목록` / `일반 페이지`를 나눕니다.
품절·가격 판정은 **상품 직랜딩에만** 적용합니다. 기획전이나 여러 상품이 모인 랜딩은 개별 상품 품절 표시가 있어도 '점검 필요'로 띄우지 않습니다 (404·페이지 없음은 그대로 점검).

**기본 광고주**: `헤라` (도메인 `hera.com`, `brand.naver.com/hera`) 가 자동 등록되고 서버 시작 시 바로 점검합니다. `src/store.js` 의 `DEFAULT_ADVERTISERS` 에서 바꿀 수 있습니다.

결과는 화면과 **CSV(소재별 On/Off 제안)**, `report.json` 으로 내보낼 수 있어 소재 On/Off 제안 자동화에 바로 연결할 수 있습니다.
새로 생긴 이슈만 슬랙으로 알립니다.

## 매체별 수집 방식

| 매체 | 소스 | 랜딩 URL | 비고 |
|---|---|---|---|
| Meta | [광고 라이브러리](https://www.facebook.com/ads/library/) (헤드리스 Chromium) | 소재의 `link_url` (l.facebook.com 래핑 해제) | 광고주명 키워드 검색 → 페이지명이 일치하는 광고만. 인스턴트 경험(캔버스)은 제외. "URL 매개변수" 필드로 붙인 UTM은 라이브러리에 안 보일 수 있음 |
| Google | [광고 투명성 센터](https://adstransparency.google.com/?region=KR) (웹앱 내부 RPC) | 미리보기의 `adurl` | **광고주 도메인으로 검색**(법인명이 달라도 됨: 헤라 → hera.com → (주)아모레퍼시픽) + 광고주명/Google 법인명 정확 일치. 일부 이미지 소재는 랜딩 URL 비공개 |
| Naver | 파워링크 더보기 검색결과 (`ad.search.naver.com`) | 노출 도메인/표시 URL | 네이버는 광고 라이브러리가 없어 **검색 키워드 기준**. 클릭 URL(`ader.naver.com`)은 과금되므로 호출하지 않음 → UTM 점검 제외 |

> 광고 클릭 URL(네이버 ader, 구글 doubleclick 등)은 절대 호출하지 않습니다. 광고주에게 클릭 과금이 발생하지 않습니다.

### 정확도 옵션 (광고주 추가 시)
- **별칭**: 페이지명이 다른 경우 (예: `클럽클리오, CLIO`)
- **도메인**: 네이버 파워링크 매칭용 (예: `clubclio.co.kr`)
- **네이버 검색 키워드**: 광고주가 실제로 입찰하는 키워드 (예: `클리오 쿠션, 클리오 립`). 비우면 광고주명으로 검색
- **Meta 페이지 ID / Google 광고주 ID(AR…)**: 이름 매칭 대신 ID로 고정

## 로컬 실행

```bash
npm install
npx playwright install chromium
npm start            # http://localhost:3000
```

CLI로 한 번만 점검:

```bash
node src/cli.js 클리오 --domains clubclio.co.kr --naver "클리오 쿠션"
```

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | |
| `DATA_DIR` | `./data` | 결과 저장 위치 (`db.json`) |
| `CHECK_CRON` | `0 */6 * * *` | 정기 점검 주기 (Asia/Seoul). `off` 로 끄기 |
| `ADMIN_PASSWORD` | – | 설정 시 Basic 인증 (아이디 아무거나) |
| `SLACK_WEBHOOK_URL` | – | 슬랙 알림 (화면의 '알림 설정'으로도 가능) |
| `PUBLIC_URL` | – | 슬랙 메시지의 '전체 결과 보기' 링크용 |
| `CRON_TOKEN` | – | 외부 스케줄러가 `POST /api/cron` 에 `x-cron-token` 헤더로 전체 점검 호출 |

## 배포 (Docker)

헤드리스 Chromium 이 필요하므로 서버리스(Vercel 등)가 아닌 **컨테이너 호스팅**을 쓰세요.

```bash
docker build -t landing-health .
docker run -p 3000:3000 -v $(pwd)/data:/data -e ADMIN_PASSWORD=change-me landing-health
```

- **Render**: [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bestsupport-gif/landing-health-check) — `render.yaml` 기본은 Free 플랜.
  Free 는 15분 유휴 시 잠들고 재시작하면 데이터가 초기화됩니다(기본 광고주 헤라는 자동 재등록·재점검). 유지하려면 Starter + Disk(`/data`)로 변경
- **Railway / Fly.io**: Dockerfile 자동 인식. Volume 을 `/data` 에 마운트

메모리는 1GB 이상 권장 (Chromium).

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/advertisers` | 광고주 목록 + 마지막 결과 요약 |
| POST | `/api/advertisers` | `{name, aliases, domains, naverKeywords, platforms}` 추가 후 즉시 점검 |
| POST | `/api/advertisers/:id/check` | 즉시 점검 (작업 ID 반환) |
| GET | `/api/jobs/:id` | 진행 로그 |
| GET | `/api/advertisers/:id/result` | 마지막 점검 상세 |
| GET | `/api/advertisers/:id/report.csv` | 소재별 On/Off 제안 CSV |
| GET | `/api/advertisers/:id/report.json` | On/Off 자동화 연동용 JSON |
| POST | `/api/check-all` | 전체 광고주 점검 |

## 한계
- 각 매체의 공개 페이지 구조가 바뀌면 크롤러 수정이 필요합니다 (`src/crawlers/*`).
- 품절·가격 판정은 페이지 구조화 데이터와 화면 문구 기반 휴리스틱입니다. 쇼핑몰마다 오탐이 있을 수 있어 `품절 의심`은 경고로만 표시합니다.
- 봇 차단이 강한 몰은 `확인 불가`로 표시됩니다.
