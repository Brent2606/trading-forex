// The bot's own dashboard: a static Dutch page that reads /status every 5 seconds.
import html from './dashboard.html?raw';

export function dashboardHtml(): string {
  return html;
}
