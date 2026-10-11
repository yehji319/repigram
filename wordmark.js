// 워드마크의 당근이 가끔씩(랜덤 간격) 깡충 뛰어요. 한 번 또는 두 번.
// 움직임 줄이기 설정을 켠 사용자에게는 움직이지 않아요.
(function hop() {
  setTimeout(() => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll(".wm-carrot").forEach((c) => {
        c.classList.remove("hop", "hop2");
        void c.offsetWidth; // 애니메이션 다시 시작
        c.classList.add(Math.random() < 0.3 ? "hop2" : "hop");
      });
    }
    hop();
  }, 1800 + Math.random() * 4200);
})();
