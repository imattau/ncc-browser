chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'hello') return undefined
  chrome.storage.local.get({ count: 0 }).then(function (value) {
    var count = Number(value.count || 0) + 1
    chrome.storage.local.set({ count: count })
    sendResponse({
      ok: true,
      count: count,
      url: sender.url,
      tabUrl: sender.tab ? sender.tab.url : ''
    })
  })
  return true
})

chrome.action.onClicked.addListener(function (tab) {
  chrome.storage.local.set({ actionClicks: Date.now(), actionTab: tab ? tab.url : '' })
})

chrome.contextMenus.create({
  id: 'hello-ncc',
  title: 'Hello from NCC',
  contexts: ['page']
})
