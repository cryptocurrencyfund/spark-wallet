import big from 'big.js'
import { Observable as O } from 'rxjs'
import { dbg, formatAmt, combine, extractErrors, dropErrors } from './util'

const reFormat = /@\{\{(\d+)\}\}/

const
  sumOuts  = outs  => outs.reduce((T, o) => T + o.value, 0)
, sumChans = chans => chans.reduce((T, c) => T + c.channel_sat, 0) * 1000
, updPaid  = (invs, paid) => invs.map(i => i.label === paid.label ? { ...i, ...paid  } : i)

, add = x => xs => [ ...xs, x ]
, rem = x => xs => xs.filter(_x => _x !== x)
, idx = xs => x => xs.indexOf(x)
, idn = x => x

const
  themes   = 'cerulean cosmo cyborg darkly flatly journal litera lumen lux materia minty pulse sandstone simplex sketchy slate solar spacelab superhero united yeti'.split(' ')
, units    = [ 'sat', 'bits', 'milli', 'btc', 'usd' ]
, unitrate = { sat: 0.001, bits: 0.00001, milli: 0.00000001, btc: 0.00000000001 }
, unitstep = { ...unitrate, usd: 0.00001 }

module.exports = ({ dismiss$, togExp$, togTheme$, togUnit$, goRecv$, recvAmt$, execRpc$, clrHist$, conf$: savedConf$
                  , HTTP, error$, invoice$, incoming$, outgoing$, funds$, payments$, invoices$, btcusd$, execRes$, info$, peers$ }) => {
  const
    conf  = (name, def, list) => savedConf$.first().map(c => c[name] || def).map(list ? idx(list) : idn)

  // Events


  // periodically re-sync from listpayments, continuously patch with known outgoing payments
  , freshPays$ = O.merge(
      payments$.map(payments => _ => payments)
    , outgoing$.map(pay => payments => [ ...payments, { ...pay, status: 'complete', created_at: Date.now()/1000|0 } ])
    ).startWith([]).scan((payments, mod) => mod(payments))

  // periodically re-sync from listinvoices, continuously patch with known invoices (paid only)
  , freshInvs$ = O.merge(
      invoices$.map(invs => _ => invs)
    , invoice$.map(inv  => invs => [ ...invs, inv ])
    , incoming$.map(inv => invs => updPaid(invs, inv))
    )
    .startWith([]).scan((invs, mod) => mod(invs))
    .map(invs => invs.filter(inv => inv.status === 'paid'))

  // periodically re-sync channel balance from "listfunds", continuously patch with known incoming & outgoing payments
  , cbalance$ = O.merge(
      funds$.map(funds  => _ => sumChans(funds.channels))
    , incoming$.map(inv => N => N + inv.msatoshi_received)
    , outgoing$.map(pay => N => N - pay.msatoshi)
    ).startWith(null).scan((N, mod) => mod(N)).distinctUntilChanged()

  // on-chain output balance (not currently used for anything, but seems useful?)
  , obalance$ = funds$.map(funds => sumOuts(funds.outputs))

  // chronologically sorted feed of incoming and outgoing payments
  , moves$    = O.combineLatest(freshInvs$, freshPays$, (invoices, payments) => [
      ...invoices.map(inv => [ 'in',  inv.paid_at,    inv.msatoshi_received, inv ])
    , ...payments.map(pay => [ 'out', pay.created_at, pay.msatoshi,          pay ])
    ].sort((a, b) => b[1] - a[1]))

  // config options
  , expert$  = conf('expert', false)        .concat(togExp$)  .scan(x => !x)
  , theme$   = conf('theme', 'yeti', themes).concat(togTheme$).scan(n => (n+1) % themes.length).map(n => themes[n])
  , unit$    = conf('unit',  'sat',  units) .concat(togUnit$) .scan(n => (n+1) % units.length) .map(n => units[n])
  , conf$    = combine({ expert$, theme$, unit$ })

  // currency & unit conversion handling
  , msatusd$ = btcusd$.map(rate => big(rate).div(100000000000)).startWith(null)
  , rate$    = O.combineLatest(unit$, msatusd$, (unit, msatusd) => unit == 'usd' ? msatusd : unitrate[unit])
  , unitf$   = O.combineLatest(unit$, rate$, (unit, rate) => msat => `${rate ? formatAmt(msat, rate, unitstep[unit]) : '⌛'} ${unit}`)

  // dynamic currency conversion for payment request form
  , recvMsat$ = recvAmt$.withLatestFrom(rate$, (amt, rate) => amt && rate && big(amt).div(rate).toFixed(0) || '').startWith(null)
  , recvForm$ = combine({
      msatoshi: recvMsat$
    , amount:   unit$.withLatestFrom(recvMsat$, rate$, (unit, msat, rate) => formatAmt(msat, rate, unitstep[unit]).replace(/,/g, '') || '')
                     .merge(goRecv$.mapTo(''))
    , step:     unit$.map(unit => unitstep[unit])
    })

  // keep track of in-flight requests
  , loading$ = HTTP.select().flatMap(r$ =>
      O.of(add(r$.request)).merge(r$.catch(_ => O.of(null)).mapTo(rem(r$.request)))
    ).startWith([]).scan((xs, mod) => mod(xs))

  // user-visible alerts
  , alert$   = O.merge(
      error$.map(err  => [ 'danger', err ])
    , incoming$.map(i => [ 'success', `Received @{{${i.msatoshi_received}}}` ])
    , outgoing$.map(i => [ 'success', `Sent @{{${i.msatoshi}}}` ])
    , dismiss$.mapTo(null).startWith(null)
    ).combineLatest(unitf$, (alert, unitf) => alert && [ alert[0], alert[1].replace(reFormat, (_, msat) => unitf(msat)) ])

  // RPC console response
  , rpcHist$  = execRes$.startWith([]).merge(clrHist$.mapTo('clear'))
      .scan((xs, x) => x == 'clear' ? [] : [ x, ...xs ].slice(0, 20))


  dbg({ reply$: HTTP.select().flatMap(r$ => r$.catch(_ => O.empty())).map(r => [ r.request.category, r.body, r.request ]) }, 'flash:reply')
  dbg({ loading$, alert$, rpcHist$ }, 'flash:model')
  dbg({ error$ }, 'flash:error')
  dbg({ unit$, rate$, recvAmt$, recvMsat$, recvForm$, msatusd$ }, 'flash:rate')

  dbg({ savedConf$, conf$, expert$, theme$, unit$, conf$ }, 'flash:config')

  return combine({ conf$, info$, alert$, loading$, moves$, peers$, cbalance$, obalance$, unitf$, recvForm$, rpcHist$ }).shareReplay(1)
}