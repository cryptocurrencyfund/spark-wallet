import { Observable as O } from './rxjs'
import views from './views'
import { dbg, combine } from './util'

const isFunc = x => typeof x == 'function'

module.exports = ({ state$, goHome$, goScan$, goSend$, goRecv$, goRpc$, goConf$, payreq$, invoice$, logs$ }) => {
  const body$ = O.merge(
    // user actions
    goHome$.startWith(1).mapTo(views.home)
  , goScan$.mapTo(views.scanReq)
  , goSend$.mapTo(views.pasteReq)
  , goRecv$.mapTo(views.recv)
  , goRpc$.mapTo(views.rpc)
  , goConf$.mapTo(views.config)

  // server responses
  , payreq$.map(views.confirmPay)
  , invoice$.flatMap(views.invoice)
  , logs$.map(views.logs)

  ).switchMap(view => isFunc(view) ? state$.map(view) : O.of(view))

  // managed outside of cycle.js due to odd cache invalidation behaviour
  // exhibited by chrome that was causing slower pageloads
  // @xxx side effects outside of drivers!
  const themeLink = document.querySelector('link[href*=bootstrap]')
  state$.map(S => S.conf.theme).distinctUntilChanged()
    .subscribe(theme => themeLink.href = `bootswatch/${theme}/bootstrap.min.css`)

  return combine({ state$, body$ }).map(views.layout)
}