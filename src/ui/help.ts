/**
 * "What is where?": a one-screen guide to the terminal, opened with the ? button and shown
 * once to a new visitor. Written directly in both languages (the page translator skips it).
 */
import { getLang } from '../core/i18n';
import { load, save } from '../core/storage';
import { $ } from './dom';

const L = (en: string, nl: string) => (getLang() === 'nl' ? nl : en);

function html(bot: boolean): string {
  const item = (n: number, title: string, text: string) => `<li><b>${n}</b><span><strong>${title}.</strong> ${text}</span></li>`;
  return `<div class="help-card">
    <h2 id="help-title">${L('What is where?', 'Wat staat waar?')}</h2>
    <p>${
      bot
        ? L(
            'This screen shows your 24/7 bot. The bot runs on the server and trades by itself with practice money; here you watch what it does and why.',
            'Dit scherm laat je 24/7-bot zien. De bot draait op de server en handelt zelf met oefengeld; hier kijk je mee wat hij doet en waarom.',
          )
        : L('This is a practice terminal: prices are simulated and no real money is involved.', 'Dit is een oefenterminal: de koersen zijn gesimuleerd en er is geen echt geld mee gemoeid.')
    }</p>
    <div class="help-grid">
      <div class="help-map" aria-hidden="true">
        <div style="grid-area:top"><span><b>1</b></span></div>
        <div style="grid-area:watch"><span><b>2</b>${L('Prices', 'Koersen')}</span></div>
        <div style="grid-area:chart"><span><b>3</b>${L('Chart', 'Grafiek')}</span></div>
        <div style="grid-area:rail"><span><b>4</b>${L('Explanation', 'Uitleg')}<br>+ ${L('order ticket', 'orderticket')}</span></div>
        <div style="grid-area:side"><span><b>6</b></span></div>
        <div style="grid-area:dock" class="hm-dock"><span><b>5</b>${L('Trades and tabs', 'Trades en tabbladen')}</span></div>
        <div style="grid-area:cmd"><span><b>7</b></span></div>
      </div>
      <ul class="help-list">
        ${item(1, L('Top bar: your account', 'Bovenbalk: je rekening'), L('Balance, today’s profit or loss, and whether the bot is trading (<strong>AUTO 24/7</strong>).', 'Saldo, de winst of het verlies van vandaag, en of de bot handelt (<strong>AUTO 24/7</strong>).'))}
        ${item(2, L('Left: prices', 'Links: koersen'), L('Live prices of 16 currency pairs. Click a pair to show it on the chart.', 'Live koersen van 16 valutaparen. Klik op een paar om het op de grafiek te zien.'))}
        ${item(3, L('Middle: the chart', 'Midden: de grafiek'), L('The price over time. Small arrows ▲▼ mark the trades on this pair.', 'De koers door de tijd. Kleine pijltjes ▲▼ zijn de trades op dit paar.'))}
        ${item(4, L('Right: explanation and order ticket', 'Rechts: uitleg en orderticket'), L('Click a trade and the explanation appears here: why it was taken and how it ended. Below it is the order ticket for trading yourself; you never have to use it.', 'Klik op een trade en hier verschijnt de uitleg: waarom hij is genomen en hoe hij afliep. Daaronder staat het orderticket om zelf te handelen; dat hoef je nooit te gebruiken.'))}
        ${item(5, L('Bottom: trades and tabs', 'Onder: trades en tabbladen'), L('<strong>Trades</strong>: everything that was traded, per day. <strong>Positions</strong>: what is running now. <strong>Autopilot 24/7</strong>: the strategies the bot uses. <strong>Performance</strong>: the statistics.', '<strong>Trades</strong>: alles wat er is gehandeld, per dag. <strong>Posities</strong>: wat nu loopt. <strong>Autopilot 24/7</strong>: de strategieën die de bot gebruikt. <strong>Prestaties</strong>: de statistieken.'))}
        ${item(6, L('Bottom left: sessions', 'Linksonder: sessies'), L('Which markets are open now, and which currencies are strong or weak.', 'Welke markten nu open zijn, en welke valuta’s sterk of zwak zijn.'))}
        ${item(7, L('Very bottom: command line', 'Helemaal onder: commandoregel'), L('A log of what happens, and a line to type commands. For advanced use; you can ignore it.', 'Een logboek van wat er gebeurt, en een regel om commando’s te typen. Voor gevorderden; je mag hem negeren.'))}
      </ul>
    </div>
    <h3>${L('How to look at a trade', 'Zo bekijk je een trade')}</h3>
    <ol class="help-steps">
      <li>${L('Open the <strong>Trades</strong> tab at the bottom. Today’s trades are at the top.', 'Open onderaan het tabblad <strong>Trades</strong>. De trades van vandaag staan bovenaan.')}</li>
      <li>${L('<strong>Click a trade.</strong> The chart jumps to it and shows the entry (IN), the exit (OUT), the target (green) and the stop loss (red).', '<strong>Klik op een trade.</strong> De grafiek springt ernaartoe en toont de instap (IN), de uitstap (UIT), het winstdoel (groen) en de stop-loss (rood).')}</li>
      <li>${L('On the right you read <strong>why the bot took the trade</strong>: the strategy, the exact signal, the plan and the result.', 'Rechts lees je <strong>waarom de bot de trade nam</strong>: de strategie, het precieze signaal, het plan en het resultaat.')}</li>
      <li>${L('Click ✕ in the explanation (or the LIVE button of the chart) to go back to the live price.', 'Klik op ✕ in de uitleg (of op de knop LIVE van de grafiek) om terug te gaan naar de live koers.')}</li>
    </ol>
    <div class="help-foot"><button type="button" class="btn ok" id="help-close">${L('Got it', 'Begrepen')}</button></div>
  </div>`;
}

export function initHelp(bot: boolean): { render(): void } {
  const el = $('help');
  const open = () => {
    el.innerHTML = html(bot);
    el.hidden = false;
    el.querySelector<HTMLElement>('#help-close')?.focus();
  };
  const close = () => {
    el.hidden = true;
    save('helpSeen', true);
  };
  $('help-btn').addEventListener('click', open);
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === el || t.closest('#help-close')) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) close();
  });
  if (!load<boolean>('helpSeen')) open();
  return {
    render: () => {
      if (!el.hidden) el.innerHTML = html(bot);
    },
  };
}
