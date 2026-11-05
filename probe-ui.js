(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  for (let i = 0; i < 40; i++) {
    if (document.querySelectorAll('.card').length > 0) break;
    await wait(500);
  }
  // 1. digest tooltip carries all three fields
  const btn = document.querySelector('.card-refresh');
  btn.click();
  for (let i = 0; i < 40; i++) {
    await wait(3000);
    if (document.querySelector('.card-digest')) break;
  }
  const dg = document.querySelector('.card-digest');
  out.hasDigest = !!dg;
  out.tooltip = dg ? dg.title : null;
  out.tooltipHasFindings = dg ? dg.title.indexOf('·') >= 0 : false;
  out.tooltipHasNext = dg ? dg.title.indexOf('下一步') >= 0 : false;
  // 2. button returns to idle (not stuck disabled)
  out.buttonEnabled = !document.querySelector('.card-refresh').disabled;
  // 3. other cards unaffected
  out.otherCardsStillRender = document.querySelectorAll('.card').length;
  // 4. regenerate works a second time
  document.querySelector('.card-refresh').click();
  await wait(3000);
  out.regenerateStarted = !!document.querySelector('.card-refresh:disabled');
  return out;
})()