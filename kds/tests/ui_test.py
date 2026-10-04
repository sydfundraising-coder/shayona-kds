import asyncio, subprocess, sys, os
from playwright.async_api import async_playwright

OUT = '/tmp/claude-0/-home-claude/282096cc-3e80-562a-a324-9e9f92c84a4f/scratchpad/shots'
os.makedirs(OUT, exist_ok=True)

async def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765'], cwd='/home/claude/kds/web',
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    await asyncio.sleep(1)
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1366, 'height': 820})
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
        base = 'http://localhost:8765/index.html?demo=1'
        await pg.goto(base + '#/')
        await pg.wait_for_selector('.tile')
        await pg.screenshot(path=f'{OUT}/01_home.png')

        await pg.goto(base + '#/station/st-pizza'); await pg.reload()
        await pg.click('[data-go="1"]')
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=f'{OUT}/02_pizza.png')
        n_before = await pg.locator('.ticket').count()
        print('pizza tickets', n_before)
        # bump first tappable item 1 unit
        it = pg.locator('.item.tap').first
        if await it.count():
            txt = await it.inner_text(); await it.click(); await pg.wait_for_timeout(500)
            print('bumped item:', txt.split('\n')[1] if '\n' in txt else txt)
            print('toast:', await pg.locator('.toast').first.inner_text())
        # bump whole order
        await pg.goto(base + '#/station/st-chaat'); await pg.wait_for_timeout(400)
        c0 = await pg.locator('.ticket').count()
        if await pg.locator('[data-act="order"]').count():
            await pg.locator('[data-act="order"]').first.click(); await pg.wait_for_timeout(500)
            print('chaat tickets', c0, 'after order bump', await pg.locator('.ticket').count())
            await pg.locator('.toast .btn').last.click(); await pg.wait_for_timeout(600)
            print('chaat tickets after undo', await pg.locator('.ticket').count())

        # each station layout
        for lay in ['rail', 'list', 'summary']:
            await pg.click('[data-top="settings"]')
            await pg.click(f'[data-pref="layout"] [data-v="{lay}"]')
            if lay == 'summary':
                await pg.click('[data-pref="sidebar"] [data-v="true"]')
            await pg.click('[data-close]')
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'{OUT}/03_pizza_{lay}.png')

        for name in ['window', 'front']:
            await pg.goto(base + f'#/{name}'); await pg.wait_for_timeout(600)
            await pg.screenshot(path=f'{OUT}/04_{name}.png')
            print(name, 'tickets', await pg.locator('.ticket').count())
        # window: finish an all-ready order
        await pg.goto(base + '#/window'); await pg.wait_for_timeout(400)
        fin = pg.locator('.ticket.all-ready [data-act="order"]')
        print('window all-ready orders', await fin.count())
        if await fin.count(): await fin.first.click(); await pg.wait_for_timeout(400)
        # force menu
        await pg.locator('[data-act="force"]').first.click(); await pg.wait_for_timeout(200)
        await pg.screenshot(path=f'{OUT}/05_force_confirm.png')
        await pg.locator('.modal [data-x="1"]').click(); await pg.wait_for_timeout(400)
        await pg.goto(base + '#/front'); await pg.wait_for_timeout(400)
        print('front ready', await pg.locator('.col.ready .ticket').count())
        col = pg.locator('.col.ready [data-act="order"]')
        if await col.count(): await col.first.click(); await pg.wait_for_timeout(400)
        await pg.click('[data-top="recall"]'); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'{OUT}/06_recall.png')
        await pg.click('[data-close]')

        await pg.goto(base + '#/board'); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'{OUT}/07_board.png')

        await pg.goto(base + '#/availability?station=st-chaat'); await pg.wait_for_timeout(400)
        await pg.locator('.switch').first.click(); await pg.wait_for_timeout(900)
        await pg.screenshot(path=f'{OUT}/08_avail.png')

        for t in ['stations', 'routing', 'settings', 'square', 'links']:
            await pg.goto(base + f'#/admin?tab={t}'); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'{OUT}/09_admin_{t}.png', full_page=False)
        await pg.goto(base + '#/admin?tab=square'); await pg.wait_for_timeout(300); await pg.click('[data-sq="test"]'); await pg.wait_for_timeout(300); print('sq:', await pg.locator('#sqout').inner_text())

        await pg.goto(base + '#/reports'); await pg.wait_for_timeout(500)
        await pg.click('[data-r="7"]'); await pg.wait_for_timeout(800)
        await pg.screenshot(path=f'{OUT}/10_rep_summary.png')
        for t in ['station', 'item', 'order', 'hour']:
            await pg.click(f'[data-t="{t}"]'); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'{OUT}/11_rep_{t}.png')

        # mobile width
        m = await b.new_page(viewport={'width': 390, 'height': 800})
        m.on('pageerror', lambda e: errors.append('PAGEERROR m ' + str(e)))
        await m.goto(base + '#/station/st-hot'); await m.click('[data-go="1"]'); await m.wait_for_timeout(500)
        await m.screenshot(path=f'{OUT}/12_mobile.png')
        await b.close()
    srv.terminate()
    print('ERRORS:', errors)

asyncio.run(main())
