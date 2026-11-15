document.addEventListener('DOMContentLoaded', function () {
  var label = document.getElementById('count')
  var button = document.getElementById('bump')
  function render(value) {
    label.textContent = 'Messages: ' + Number(value.count || 0)
  }
  chrome.storage.local.get({ count: 0 }).then(render)
  button.addEventListener('click', function () {
    chrome.storage.local.get({ count: 0 }).then(function (value) {
      var next = Number(value.count || 0) + 1
      chrome.storage.local.set({ count: next }).then(function () {
        render({ count: next })
      })
    })
  })
})
