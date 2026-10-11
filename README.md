# 🍳 Repigram

사진과 SNS에서 발견한 요리법을 AI가 정리해 주는 나만의 레시피북 — https://repigram.com

## 기능
| | 무료 | 프리미엄 |
|---|---|---|
| Google 로그인, 클라우드 저장 (어느 기기에서든) | ✅ | ✅ |
| 사진·캡처·캡션 + 유튜브 설명란 AI 정리 (Claude Haiku 5.5) | 하루 10회 | 하루 50회 |
| 유튜브 영상 직접 분석 (Gemini) | – | 월 30개 (30분 이하 공개 영상) |

- 🍳 **요리 모드**: 화면 꺼짐 방지, 큰 글씨, 단계별 스와이프, 단계 속 시간 자동 타이머
- ➕➖ **분량 조절**: 2인분 → 4인분 재료 자동 계산
- 🛒 **장보기 목록**: 레시피 재료 담기, 체크, 목록 공유
- 📅 **식단**: 오늘부터 7일 계획, 7일 치 재료 한 번에 장보기
- ▶ **영상 장면 이동**: 단계를 누르면 원본 영상의 해당 장면 재생
- 🔗 **공유로 저장**: 유튜브·인스타그램의 공유 버튼 → Repigram (안드로이드 PWA), 링크 붙여넣기
- 검색·분류·즐겨찾기, 원본 링크 보관, 백업 내보내기/불러오기, PWA(홈 화면 설치)

수익 모델과 광고·제휴 자리: [docs/monetization.md](docs/monetization.md) · 설정 파일 `partners.js` (비어 있으면 화면에 안 보임)

## 구조
```
브라우저/앱 ──(로그인·레시피·사진)──▶ Supabase (Google 로그인, DB, Storage, RLS)
     │
     └──(AI 요청 + 로그인 토큰)──▶ Cloudflare Worker ──▶ Claude Haiku 5.5 (사진·글)
                                   (키 보관·등급 확인·한도)  └▶ Gemini (영상, 프리미엄)
                                                           └▶ YouTube Data API (영상 정보)
```

## 파일 구성
| 파일 | 역할 |
|---|---|
| `index.html`, `app.js`, `styles.css` | 앱 화면 |
| `config.js` | 서버 주소, Supabase 공개 키 (비밀 키는 넣지 않음) |
| `supabase.js`, `db.js` | 로그인, 레시피·사진 클라우드 저장 |
| `ai.js` | AI 서버 호출 |
| `worker/` | AI 서버 (Cloudflare Worker) |
| `supabase/schema.sql` | DB 테이블·보안 규칙 (Supabase SQL Editor에서 한 번 실행) |
| `terms.html`, `privacy.html`, `copyright.html` | 이용약관, 개인정보처리방침, 저작권 정책 (초안) |
| `docs/legal-guide.md` | 운영자용 저작권·법률 체크리스트 |
| `logo.png` | 로고 캐릭터 |
| `manifest.webmanifest`, `sw.js` | 앱 설치(PWA) |

## 로컬에서 실행
ES 모듈을 쓰기 때문에 `index.html`을 직접 열면 동작하지 않아요. 간단한 로컬 서버로 실행하세요 (예: `npx serve .`).
