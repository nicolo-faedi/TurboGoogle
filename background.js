const WELCOME_URL = 'https://buymeacoffee.com/nicuzz4z';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;

  chrome.tabs.create({ url: WELCOME_URL, active: true });
});
