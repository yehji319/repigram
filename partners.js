// 제휴·광고 자리 설정. 비어 있으면 화면에 아무것도 보이지 않아요.
// 제휴가 생기면 여기만 채우면 화면 곳곳의 자리에 자동으로 나타나요.
// ⚠️ 채울 때는 반드시 disclosure(광고·제휴 표시)를 넣어야 해요 (표시광고법, 추천·보증 심사지침).

// 1) 장보기 연결: 재료를 바로 검색·주문 (쿠팡, 네이버, 컬리 등)
// 예: { id: "coupang", name: "쿠팡", color: "#E52528",
//       searchUrl: (q) => `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}`,
//       disclosure: "쿠팡 파트너스 활동의 일환으로 일정액의 수수료를 제공받습니다." }
export const COMMERCE = [];

// 2) 스폰서 자리: 아래 이름의 자리에 넣을 콘텐츠
// 예: { title: "...", text: "...", image: "...", url: "...", label: "광고" }
export const SPONSORED = {
  homeFeed: null,       // 레시피북 목록 사이 (카드 6개마다 한 번)
  recipeDetail: null,   // 레시피 상세의 재료 아래 (추천 도구·재료)
  shopping: null,       // 장보기 목록 아래
  cookingDone: null,    // 요리 모드 완성 화면
  planWeek: null,       // 식단 화면 아래 (밀키트 등)
};

// 3) 보상형 광고: 무료 회원이 AI 횟수를 다 썼을 때 "광고 보고 1회 더" (앱 출시 후 AdMob 등)
// 예: { label: "광고 보고 1회 더 정리하기", show: async () => true /* 광고 시청 완료 여부 */ }
export const REWARDED_AD = null;
