let preUrl = '', preBranch = ''
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (changeInfo.url && preUrl !== changeInfo.url) {
        preUrl = changeInfo.url
        const param = getParam(changeInfo.url)
        console.log(param)
        if (preBranch !==  param.at) {
          chrome.tabs.sendMessage(tabId, 'url-update-branch');
        }
        preBranch = param.at
    }
});


function getParam (url) {
  url = decodeURIComponent(url)
  const index = url.indexOf('?')
  const searchArr = index > -1 ? url.slice(index+1,).split('&') : [] 
  const queryParams = {}
  searchArr.forEach((val) => {
    const valArr = val.split('=')
    if (valArr.length === 2) {
      queryParams[valArr[0]] = valArr[1]
    }
  })
  return queryParams
}