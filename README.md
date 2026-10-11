# 🍳 Repigram

사진과 SNS에서 발견한 요리법을 모아 관리하는 나만의 레시피북 — https://repigram.com

## 기능
- **사진 기반 등록**: 요리 사진, 유튜브·인스타그램 캡처를 올려 레시피 저장
- **AI 자동 정리 (선택)**: 사진·캡션을 분석해 제목·재료·조리 순서를 채워 줌 (서버에서 Claude Haiku 5.5 사용)
- **검색·분류·즐겨찾기**: 제목, 재료, 메모 검색 / 카테고리 필터
- **원본 링크**: 유튜브·인스타그램 출처 저장
- **브라우저 저장 + 백업**: IndexedDB에 저장, JSON 백업 내보내기/불러오기
- **PWA**: 휴대폰 홈 화면에 앱처럼 설치 가능, 오프라인에서도 열림

## 파일 구성
| 파일 | 역할 |
|---|---|
| `index.html` | 페이지 뼈대 |
| `app.js` | 화면과 동작 (목록, 상세, 추가/수정, 설정) |
| `db.js` | IndexedDB 저장소 |
| `ai.js`, `config.js` | AI 서버 호출 (`config.js`에 서버 주소) |
| `worker/` | AI 서버 (Cloudflare Worker, Claude Haiku 5.5, API 키 보관·사용량 제한) |
| `styles.css` | 디자인 |
| `manifest.webmanifest`, `sw.js`, `icon.svg` | 앱 설치(PWA) |
| `CNAME` | 사용자 도메인 (repigram.com) |

## 로컬에서 실행
ES 모듈을 쓰기 때문에 `index.html`을 직접 열면 동작하지 않아요. 간단한 로컬 서버로 실행하세요 (예: `npx serve .` 또는 `python -m http.server`).
