import { chromium } from 'playwright-core';
const base='http://127.0.0.1:8080';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-gpu','--no-proxy-server']});
async function register(page,name,email){
 await page.goto(base); await page.click('#auth-register-tab');
 await page.fill('#register-email',email); await page.fill('#register-name',name);
 await page.fill('#register-password','password123'); await page.fill('#register-password2','password123');
 await page.click('#register-form button[type=submit]'); await page.waitForSelector('#verify-form:not(.hidden)');
 await page.click('#verify-form button[type=submit]'); await page.waitForSelector('#lobby-view:not(.hidden)',{timeout:10000});
}
async function createJoin(host,guest,gameName){
 await host.locator('#game-list .item',{hasText:gameName}).locator('button',{hasText:'创建房间'}).click();
 await host.waitForSelector('#create-dialog[open]');
 await host.locator('#create-room-form button[type=submit]').click();
 await host.waitForSelector('#room-view:not(.hidden)',{timeout:10000});
 await guest.click('#refresh-lobby'); await guest.waitForSelector('#room-list .item');
 await guest.locator('#room-list .item').first().locator('button',{hasText:'加入'}).click();
 await guest.waitForSelector('#room-view:not(.hidden)');
 for(const p of [host,guest]) await p.locator('#room-actions button',{hasText:'准备'}).click();
 await host.waitForTimeout(150);
 await host.locator('#room-actions button',{hasText:'开始游戏'}).click();
}
const host=await (await browser.newContext()).newPage();
const guest=await (await browser.newContext()).newPage();
host.on('pageerror',e=>console.log('HOSTERR',e.message)); guest.on('pageerror',e=>console.log('GUESTERR',e.message));
await register(host,'GomokuHost3','gomoku-host3@example.test');
await register(guest,'GomokuGuest3','gomoku-guest3@example.test');
// Free 11x11
await createJoin(host,guest,'五子棋（无禁手）');
await host.waitForSelector('.gomoku-board.size-11',{timeout:10000});
console.log('free cells',await host.locator('.gomoku-cell').count());
console.log('free turn',await host.locator('.gomoku-turn').innerText());
console.log('free stone count',await host.locator('.gomoku-stone').count());
console.log('free hint elements',await host.locator('.gomoku-hint').count());
console.log('free hint buttons',await host.locator('button',{hasText:/提示/}).count());
await host.screenshot({path:'docs/assets/gomoku.png',fullPage:true});
await host.locator('.gomoku-cell').nth(0).click();
await host.waitForTimeout(250);
console.log('free last mark',await host.locator('.gomoku-last-mark').count());
for(const p of [host,guest]) await p.locator('#room-actions button',{hasText:'离开房间'}).click();
await host.waitForSelector('#lobby-view:not(.hidden)'); await guest.waitForSelector('#lobby-view:not(.hidden)');
// Seki 15x15
await createJoin(host,guest,'五子棋（无禁手·彗星座子）');
await host.waitForSelector('.gomoku-board.size-15',{timeout:10000});
console.log('seki cells',await host.locator('.gomoku-cell').count());
console.log('seki stones',await host.locator('.gomoku-stone.black').count(),await host.locator('.gomoku-stone.white').count());
console.log('seki host turn',await host.locator('.gomoku-turn').innerText());
console.log('seki guest turn',await guest.locator('.gomoku-turn').innerText());
console.log('seki stars',await host.locator('.gomoku-cell.star').count());
await host.screenshot({path:'docs/assets/gomoku-seki.png',fullPage:true});
// White (guest) moves first
await guest.locator('.gomoku-cell').nth(0).click();
await guest.waitForTimeout(250);
console.log('seki after white move last',await guest.locator('.gomoku-last-mark').count());
await browser.close();
