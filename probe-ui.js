(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    if (document.querySelectorAll('.card').length > 0) break;
    await wait(500);
  }
  const out = {
    title: document.title,
    cards: document.querySelectorAll('.card').length,
    frames: document.querySelectorAll('.frame').length,
    status: (document.getElementById('status') || {}).textContent,
    searchBox: !!document.getElementById('search'),
    langButton: (document.getElementById('btn-lang') || {}).textContent,
    topbarButtons: document.querySelectorAll('#topbar button').length,
  };
  return out;
})()