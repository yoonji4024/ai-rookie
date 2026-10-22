/** No page URLs are read. Only the installed content script can acknowledge. */
export async function openOnTab(tabs: {
  query: (info: {active: boolean; currentWindow: boolean}) => Promise<{id?: number}[]>;
  sendMessage: (tabId: number, message: {v: number; type: string}) => Promise<unknown>;
}): Promise<boolean> {
  try {
    const [tab] = await tabs.query({active: true, currentWindow: true});
    if (typeof tab?.id !== 'number') return false;
    const reply = await tabs.sendMessage(tab.id, {v: 2, type: 'pet/open'});
    return typeof reply === 'object' && reply !== null &&
      (reply as {opened?: unknown}).opened === true;
  } catch { return false; }
}
