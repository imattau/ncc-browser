(function () {
  document.documentElement.dataset.helloExtension = '1'

  var button = document.createElement('button')
  button.id = 'ncc-ext-sign'
  button.textContent = 'Extension sign'
  button.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:6px 10px;font:12px sans-serif'
  button.addEventListener('click', function () {
    ncc.nostr
      .getPublicKey()
      .then(function (pubkey) {
        document.documentElement.dataset.helloPubkey = pubkey
        return ncc.nostr.signEvent({
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: 'hello from an NCC extension'
        })
      })
      .then(function (event) {
        document.documentElement.dataset.helloSigned = event.id
      })
      .catch(function (error) {
        document.documentElement.dataset.helloError = String(error)
      })
  })
  document.body.appendChild(button)

  chrome.runtime
    .sendMessage({ type: 'hello' })
    .then(function (response) {
      document.documentElement.dataset.helloCount = String(response ? response.count : '')
    })
    .catch(function (error) {
      document.documentElement.dataset.helloError = String(error)
    })
})()
