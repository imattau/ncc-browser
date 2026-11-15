document.getElementById('origin').textContent = location.origin
chrome.storage.local.get({ count: 0 }).then(function (value) {
  document.getElementById('count').textContent = 'Stored messages: ' + Number(value.count || 0)
})
