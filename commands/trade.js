var tb = require('timebucket')
  , minimist = require('minimist')
  , n = require('numbro')
  , fs = require('fs')
  , path = require('path')
  , spawn = require('child_process').spawn
  , moment = require('moment')
  , crypto = require('crypto')
  , readline = require('readline')
  , colors = require('colors')
  , z = require('zero-fill')
  , cliff = require('cliff')
  , output = require('../lib/output')
  , objectifySelector = require('../lib/objectify-selector')
  , engineFactory = require('../lib/engine')
  , collectionService = require('../lib/services/collection-service')

module.exports = function (program, conf) {
  program
    .command('trade [selector]')
    .allowUnknownOption()
    .description('run trading bot against live market data')
    .option('--conf <path>', 'path to optional conf overrides file')
    .option('--strategy <name>', 'strategy to use', String, conf.strategy)
    .option('--order_type <type>', 'order type to use (maker/taker)', /^(maker|taker)$/i, conf.order_type)
    .option('--paper', 'use paper trading mode (no real trades will take place)', Boolean, false)
    .option('--manual', 'watch price and account balance, but do not perform trades automatically', Boolean, false)
    .option('--non_interactive', 'disable keyboard inputs to the bot', Boolean, false)
    .option('--currency_capital <amount>', 'for paper trading, amount of start capital in currency', Number, conf.currency_capital)
    .option('--asset_capital <amount>', 'for paper trading, amount of start capital in asset', Number, conf.asset_capital)
    .option('--avg_slippage_pct <pct>', 'avg. amount of slippage to apply to paper trades', Number, conf.avg_slippage_pct)
    .option('--buy_pct <pct>', 'buy with this % of currency balance', Number, conf.buy_pct)
    .option('--buy_max_amt <amt>', 'buy with up to this amount of currency balance', Number, conf.buy_max_amt)
    .option('--sell_pct <pct>', 'sell with this % of asset balance', Number, conf.sell_pct)
    .option('--markdown_buy_pct <pct>', '% to mark down buy price', Number, conf.markdown_buy_pct)
    .option('--markup_sell_pct <pct>', '% to mark up sell price', Number, conf.markup_sell_pct)
    .option('--order_adjust_time <ms>', 'adjust bid/ask on this interval to keep orders competitive', Number, conf.order_adjust_time)
    .option('--order_poll_time <ms>', 'poll order status on this interval', Number, conf.order_poll_time)
    .option('--sell_stop_pct <pct>', 'sell if price drops below this % of bought price', Number, conf.sell_stop_pct)
    .option('--buy_stop_pct <pct>', 'buy if price surges above this % of sold price', Number, conf.buy_stop_pct)
    .option('--profit_stop_enable_pct <pct>', 'enable trailing sell stop when reaching this % profit', Number, conf.profit_stop_enable_pct)
    .option('--profit_stop_pct <pct>', 'maintain a trailing stop this % below the high-water mark of profit', Number, conf.profit_stop_pct)
    .option('--max_sell_loss_pct <pct>', 'avoid selling at a loss pct under this float', conf.max_sell_loss_pct)
    .option('--max_buy_loss_pct <pct>', 'avoid buying at a loss pct over this float', conf.max_buy_loss_pct)
    .option('--max_slippage_pct <pct>', 'avoid selling at a slippage pct above this float', conf.max_slippage_pct)
    .option('--rsi_periods <periods>', 'number of periods to calculate RSI at', Number, conf.rsi_periods)
    .option('--poll_trades <ms>', 'poll new trades at this interval in ms', Number, conf.poll_trades)
    .option('--currency_increment <amount>', 'Currency increment, if different than the asset increment', String, null)
    .option('--keep_lookback_periods <amount>', 'Keep this many lookback periods max. ', Number, conf.keep_lookback_periods)
    .option('--exact_buy_orders', 'instead of only adjusting maker buy when the price goes up, adjust it if price has changed at all')
    .option('--exact_sell_orders', 'instead of only adjusting maker sell when the price goes down, adjust it if price has changed at all')
    .option('--use_prev_trades', 'load and use previous trades for stop-order triggers and loss protection')
    .option('--disable_stats', 'disable printing order stats')
    .option('--reset_profit', 'start new profit calculation from 0')
    .option('--run_for <minutes>', 'Execute for a period of minutes then exit with status 0', String, null)
    .option('--debug', 'output detailed debug info')
    .action(function (selector, cmd) {
      var raw_opts = minimist(process.argv)
      var s = {options: JSON.parse(JSON.stringify(raw_opts))}
      var so = s.options
      if (so.run_for) {
        var botStartTime = moment().add(so.run_for, 'm')
      }
      delete so._
      if (cmd.conf) {
        var overrides = require(path.resolve(process.cwd(), cmd.conf))
        Object.keys(overrides).forEach(function (k) {
          so[k] = overrides[k]
        })
      }
      Object.keys(conf).forEach(function (k) {
        if (typeof cmd[k] !== 'undefined') {
          so[k] = cmd[k]
        }
      })
      so.currency_increment = cmd.currency_increment
      so.keep_lookback_periods = cmd.keep_lookback_periods
      so.use_prev_trades = (cmd.use_prev_trades||conf.use_prev_trades)
      so.debug = cmd.debug
      so.stats = !cmd.disable_stats
      so.mode = so.paper ? 'paper' : 'live'

      so.selector = objectifySelector(selector || conf.selector)      
      var engine = engineFactory(s, conf)
      var collectionServiceInstance = collectionService(conf)

      const keyMap = new Map()
      keyMap.set('b', 'limit'.grey + ' BUY'.green)
      keyMap.set('B', 'market'.grey + ' BUY'.green)
      keyMap.set('s', 'limit'.grey + ' SELL'.red)
      keyMap.set('S', 'market'.grey + ' SELL'.red)
      keyMap.set('c', 'cancel order'.grey)
      keyMap.set('m', 'toggle MANUAL trade in LIVE mode ON / OFF'.grey)
      keyMap.set('T', 'switch to \'Taker\' order type'.grey)
      keyMap.set('M', 'switch to \'Maker\' order type'.grey)
      keyMap.set('o', 'show current trade options'.grey)
      keyMap.set('O', 'show current trade options in a dirty view (full list)'.grey)
      keyMap.set('L', 'toggle DEBUG'.grey)
      keyMap.set('P', 'print statistical output'.grey)
      keyMap.set('X', 'exit program with statistical output'.grey)
      keyMap.set('d', 'dump statistical output to HTML file'.grey)
      keyMap.set('D', 'toggle automatic HTML dump to file'.grey)

      function listKeys() {
        console.log('\nAvailable command keys:')
        keyMap.forEach((value, key) => {
          console.log(' ' + key + ' - ' + value)
        })
      }

      function listOptions () {
        console.log()
        console.log(s.exchange.name.toUpperCase() + ' exchange active trading options:'.grey)
        console.log()
        process.stdout.write(z(22, 'STRATEGY'.grey, ' ') + '\t' + so.strategy + '\t' + (require(`../extensions/strategies/${so.strategy}/strategy`).description).grey)
        console.log('\n')
        process.stdout.write([
          z(24, (so.mode === 'paper' ? so.mode.toUpperCase() : so.mode.toUpperCase()) + ' MODE'.grey, ' '),
          z(26, 'PERIOD'.grey, ' '),
          z(30, 'ORDER TYPE'.grey, ' '),
          z(28, 'SLIPPAGE'.grey, ' '),
          z(33, 'EXCHANGE FEES'.grey, ' ')
        ].join('') + '\n')
        process.stdout.write([
          z(15, (so.mode === 'paper' ? '      ' : (so.mode === 'live' && (so.manual === false || typeof so.manual === 'undefined')) ? '       ' + 'AUTO'.black.bgRed + '    ' : '       ' + 'MANUAL'.black.bgGreen + '  '), ' '),
          z(13, so.period_length, ' '),
          z(29, (so.order_type === 'maker' ? so.order_type.toUpperCase().green : so.order_type.toUpperCase().red), ' '),
          z(31, (so.mode === 'paper' ? 'avg. '.grey + so.avg_slippage_pct + '%' : 'max '.grey + so.max_slippage_pct + '%'), ' '),
          z(20, (so.order_type === 'maker' ? so.order_type + ' ' + s.exchange.makerFee : so.order_type + ' ' + s.exchange.takerFee), ' ')
        ].join('') + '\n')
        process.stdout.write('')
        process.stdout.write([
          z(19, 'BUY %'.grey, ' '),
          z(20, 'SELL %'.grey, ' '),
          z(35, 'TRAILING STOP %'.grey, ' '),
          z(33, 'TRAILING DISTANCE %'.grey, ' ')
        ].join('') + '\n')
        process.stdout.write([
          z(9, so.buy_pct + '%', ' '),
          z(9, so.sell_pct + '%', ' '),
          z(20, so.profit_stop_enable_pct + '%', ' '),
          z(20, so.profit_stop_pct + '%', ' ')
        ].join('') + '\n')
        process.stdout.write('')
      }

      /* Implementing statistical Exit */
      function printTrade (quit, dump, statsonly = false) {
        var tmp_balance = n(s.balance.currency).add(n(s.period.close).multiply(s.balance.asset)).format('0.00000000')
        if (quit) {
          if (s.my_trades.length) {
            s.my_trades.push({
              price: s.period.close,
              size: s.balance.asset,
              type: 'sell',
              time: s.period.time
            })
          }
          s.balance.currency = tmp_balance
          s.balance.asset = 0
          s.lookback.unshift(s.period)
        }
        var profit = s.start_capital ? n(tmp_balance).subtract(s.start_capital).divide(s.start_capital) : n(0)
        var buy_hold = s.start_price ? n(s.period.close).multiply(n(s.start_capital).divide(s.start_price)) : n(tmp_balance)
        var buy_hold_profit = s.start_capital ? n(buy_hold).subtract(s.start_capital).divide(s.start_capital) : n(0)
        if (!statsonly) {
          console.log()
          var output_lines = []
          output_lines.push('last balance: ' + n(tmp_balance).format('0.00000000').yellow + ' (' + profit.format('0.00%') + ')')
          output_lines.push('buy hold: ' + buy_hold.format('0.00000000').yellow + ' (' + n(buy_hold_profit).format('0.00%') + ')')
          output_lines.push('vs. buy hold: ' + n(tmp_balance).subtract(buy_hold).divide(buy_hold).format('0.00%').yellow)
          output_lines.push(s.my_trades.length + ' trades over ' + s.day_count + ' days (avg ' + n(s.my_trades.length / s.day_count).format('0.00') + ' trades/day)')
        }
        // Build stats for UI
        s.stats = {
          profit: profit.format('0.00%'),
          tmp_balance: n(tmp_balance).format('0.00000000'),
          buy_hold: buy_hold.format('0.00000000'),
          buy_hold_profit: n(buy_hold_profit).format('0.00%'),
          day_count: s.day_count,
          trade_per_day: n(s.my_trades.length / s.day_count).format('0.00')
        }

        var last_buy
        var losses = 0, sells = 0
        s.my_trades.forEach(function (trade) {
          if (trade.type === 'buy') {
            last_buy = trade.price
          }
          else {
            if (last_buy && trade.price < last_buy) {
              losses++
            }
            sells++
          }
        })
        if (s.my_trades.length && sells > 0) {
          if (!statsonly) {
            output_lines.push('win/loss: ' + (sells - losses) + '/' + losses)
            output_lines.push('error rate: ' + (sells ? n(losses).divide(sells).format('0.00%') : '0.00%').yellow)
          }

          //for API
          s.stats.win = (sells - losses)
          s.stats.losses = losses
          s.stats.error_rate = (sells ? n(losses).divide(sells).format('0.00%') : '0.00%')
        }
        if (!statsonly) {
          output_lines.forEach(function (line) {
            console.log(line)
          })
        }
        if (quit || dump) {
          var html_output = output_lines.map(function (line) {
            return colors.stripColors(line)
          }).join('\n')
          var data = s.lookback.slice(0, s.lookback.length - so.min_periods).map(function (period) {
            var data = {}
            var keys = Object.keys(period)
            for(var i = 0; i < keys.length; i++){
              data[keys[i]] = period[keys[i]]
            }
            return data
          })
          var code = 'var data = ' + JSON.stringify(data) + ';\n'
          code += 'var trades = ' + JSON.stringify(s.my_trades) + ';\n'
          var tpl = fs.readFileSync(path.resolve(__dirname, '..', 'templates', 'sim_result.html.tpl'), {encoding: 'utf8'})
          var out = tpl
            .replace('{{code}}', code)
            .replace('{{trend_ema_period}}', so.trend_ema || 36)
            .replace('{{output}}', html_output)
            .replace(/\{\{symbol\}\}/g,  so.selector.normalized + ' - zenbot ' + require('../package.json').version)
          if (so.filename !== 'none') {
            var out_target
            var out_target_prefix = so.paper ? 'simulations/paper_result_' : 'stats/trade_result_'
            if(dump){
              var dt = new Date().toISOString()

              //ymd
              var today = dt.slice(2, 4) + dt.slice(5, 7) + dt.slice(8, 10)
              out_target = so.filename || out_target_prefix + so.selector.normalized +'_' + today + '_UTC.html'
              fs.writeFileSync(out_target, out)
            }else
              out_target = so.filename || out_target_prefix + so.selector.normalized +'_' + new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/-/g, '').replace(/:/g, '').replace(/20/, '') + '_UTC.html'

            fs.writeFileSync(out_target, out)
            console.log('\nwrote'.grey, out_target)
          }
          if(quit) process.exit(0)
        }
      }
      /* The end of printTrade */

      /* Implementing statistical status dump every 10 secs */
      var shouldSaveStats = false
      function toggleStats(){
        shouldSaveStats = !shouldSaveStats
        if(shouldSaveStats)
          console.log('Auto stats dump enabled')
        else
          console.log('Auto stats dump disabled')
      }

      function saveStatsLoop(){
        saveStats()
        setTimeout(function () {
          saveStatsLoop()
        }, 10000)
      }
      saveStatsLoop()

      function saveStats () {
        if(!shouldSaveStats) return

        var output_lines = []
        var tmp_balance = n(s.balance.currency).add(n(s.period.close).multiply(s.balance.asset)).format('0.00000000')

        var profit = s.start_capital ? n(tmp_balance).subtract(s.start_capital).divide(s.start_capital) : n(0)
        output_lines.push('last balance: ' + n(tmp_balance).format('0.00000000').yellow + ' (' + profit.format('0.00%') + ')')
        var buy_hold = s.start_price ? n(s.period.close).multiply(n(s.start_capital).divide(s.start_price)) : n(tmp_balance)
        var buy_hold_profit = s.start_capital ? n(buy_hold).subtract(s.start_capital).divide(s.start_capital) : n(0)
        output_lines.push('buy hold: ' + buy_hold.format('0.00000000').yellow + ' (' + n(buy_hold_profit).format('0.00%') + ')')
        output_lines.push('vs. buy hold: ' + n(tmp_balance).subtract(buy_hold).divide(buy_hold).format('0.00%').yellow)
        output_lines.push(s.my_trades.length + ' trades over ' + s.day_count + ' days (avg ' + n(s.my_trades.length / s.day_count).format('0.00') + ' trades/day)')
        // Build stats for UI
        s.stats = {
          profit: profit.format('0.00%'),
          tmp_balance: n(tmp_balance).format('0.00000000'),
          buy_hold: buy_hold.format('0.00000000'),
          buy_hold_profit: n(buy_hold_profit).format('0.00%'),
          day_count: s.day_count,
          trade_per_day: n(s.my_trades.length / s.day_count).format('0.00')
        }

        var last_buy
        var losses = 0, sells = 0
        s.my_trades.forEach(function (trade) {
          if (trade.type === 'buy') {
            last_buy = trade.price
          }
          else {
            if (last_buy && trade.price < last_buy) {
              losses++
            }
            sells++
          }
        })
        if (s.my_trades.length && sells > 0) {
          output_lines.push('win/loss: ' + (sells - losses) + '/' + losses)
          output_lines.push('error rate: ' + (sells ? n(losses).divide(sells).format('0.00%') : '0.00%').yellow)

          //for API
          s.stats.win = (sells - losses)
          s.stats.losses = losses
          s.stats.error_rate = (sells ? n(losses).divide(sells).format('0.00%') : '0.00%')
        }

        var html_output = output_lines.map(function (line) {
          return colors.stripColors(line)
        }).join('\n')
        var data = s.lookback.slice(0, s.lookback.length - so.min_periods).map(function (period) {
          var data = {}
          var keys = Object.keys(period)
          for(var i = 0; i < keys.length; i++){
            data[keys[i]] = period[keys[i]]
          }
          return data
        })
        var code = 'var data = ' + JSON.stringify(data) + ';\n'
        code += 'var trades = ' + JSON.stringify(s.my_trades) + ';\n'
        var tpl = fs.readFileSync(path.resolve(__dirname, '..', 'templates', 'sim_result.html.tpl'), {encoding: 'utf8'})
        var out = tpl
          .replace('{{code}}', code)
          .replace('{{trend_ema_period}}', so.trend_ema || 36)
          .replace('{{output}}', html_output)
          .replace(/\{\{symbol\}\}/g,  so.selector.normalized + ' - zenbot ' + require('../package.json').version)
        if (so.filename !== 'none') {
          var out_target
          var dt = new Date().toISOString()

          //ymd
          var today = dt.slice(2, 4) + dt.slice(5, 7) + dt.slice(8, 10)
          out_target = so.filename || 'simulations/trade_result_' + so.selector.normalized +'_' + today + '_UTC.html'

          fs.writeFileSync(out_target, out)
          //console.log('\nwrote'.grey, out_target)
        }

      }

      var order_types = ['maker', 'taker']
      if (!order_types.includes(so.order_type)) {
        so.order_type = 'maker'
      }

      var db_cursor, trade_cursor
      var query_start = tb().resize(so.period_length).subtract(so.min_periods * 2).toMilliseconds()
      var days = Math.ceil((new Date().getTime() - query_start) / 86400000)
      var session = null
      var sessions = collectionServiceInstance.getSessions()
      var balances = collectionServiceInstance.getBalances()
      var trades = collectionServiceInstance.getTrades()
      var resume_markers = collectionServiceInstance.getResumeMarkers()
      var marker = {
        id: crypto.randomBytes(4).toString('hex'),
        selector: so.selector.normalized,
        from: null,
        to: null,
        oldest_time: null
      }
      marker._id = marker.id
      var lookback_size = 0
      var my_trades_size = 0
      var my_trades = collectionServiceInstance.getMyTrades()
      var periods = collectionServiceInstance.getPeriods()

      console.log('fetching pre-roll data:')
      var zenbot_cmd = process.platform === 'win32' ? 'zenbot.bat' : 'zenbot.sh' // Use 'win32' for 64 bit windows too
      var command_args = ['backfill', so.selector.normalized, '--days', days || 1]
      if (cmd.conf) {
        command_args.push('--conf', cmd.conf)
      }
      var backfiller = spawn(path.resolve(__dirname, '..', zenbot_cmd), command_args)
      backfiller.stdout.pipe(process.stdout)
      backfiller.stderr.pipe(process.stderr)
      backfiller.on('exit', function (code) {
        if (code) {
          process.exit(code)
        }
        function getNext () {
          var opts = {
            query: {
              selector: so.selector.normalized
            },
            sort: {time: 1},
            limit: 1000
          }
          if (db_cursor) {
            opts.query.time = {$gt: db_cursor}
          }
          else {
            trade_cursor = s.exchange.getCursor(query_start)
            opts.query.time = {$gte: query_start}
          }
          trades.find(opts.query).limit(opts.limit).sort(opts.sort).toArray(function (err, trades) {
            if (err) throw err
            if (trades.length && so.use_prev_trades) {
              my_trades.find({selector: so.selector.normalized, time : {$gte : trades[0].time}}).limit(0).toArray(function (err, my_prev_trades) {
                if (err) throw err
                if (my_prev_trades.length) {
                  s.my_prev_trades = my_prev_trades.slice(0).sort(function(a,b){return a.time + a.execution_time > b.time + b.execution_time ? -1 : 1}) // simple copy, most recent executed first
                }
              })
            }
            if (!trades.length) {
              var head = '------------------------------------------ INITIALIZE  OUTPUT ------------------------------------------'
              console.log(head)
              output(conf).initializeOutput(s)
              var minuses = Math.floor((head.length - so.mode.length - 19) / 2)
              console.log('-'.repeat(minuses) + ' STARTING ' + so.mode.toUpperCase() + ' TRADING ' + '-'.repeat(minuses + (minuses % 2 == 0 ? 0 : 1)))
              if (so.mode === 'paper') {
                console.log('!!! Paper mode enabled. No real trades are performed until you remove --paper from the startup command.')
              }
              console.log('Press ' + ' l '.inverse + ' to list available commands.')
              engine.syncBalance(function (err) {
                if (err) {
                  if (err.desc) console.error(err.desc)
                  if (err.body) console.error(err.body)
                  throw err
                }
                session = {
                  id: crypto.randomBytes(4).toString('hex'),
                  selector: so.selector.normalized,
                  started: new Date().getTime(),
                  mode: so.mode,
                  options: so
                }
                session._id = session.id
                sessions.find({selector: so.selector.normalized}).limit(1).sort({started: -1}).toArray(function (err, prev_sessions) {
                  if (err) throw err
                  var prev_session = prev_sessions[0]
                  if (prev_session && !cmd.reset_profit) {
                    if (prev_session.orig_capital && prev_session.orig_price && ((so.mode === 'paper' && !raw_opts.currency_capital && !raw_opts.asset_capital) || (so.mode === 'live' && prev_session.balance.asset == s.balance.asset && prev_session.balance.currency == s.balance.currency))) {
                      s.orig_capital = session.orig_capital = prev_session.orig_capital
                      s.orig_price = session.orig_price = prev_session.orig_price
                      if (so.mode === 'paper') {
                        s.balance = prev_session.balance
                      }
                    }
                  }
                  if(s.lookback.length > so.keep_lookback_periods){
                    s.lookback.splice(-1,1)
                  }

                  forwardScan()
                  setInterval(forwardScan, so.poll_trades)
                  readline.emitKeypressEvents(process.stdin)
                  if (!so.non_interactive && process.stdin.setRawMode) {
                    process.stdin.setRawMode(true)
                    process.stdin.on('keypress', function (key, info) {
                      if (key === 'l') {
                        listKeys()
                      } else if (key === 'b' && !info.ctrl ) {
                        engine.executeSignal('buy')
                        console.log('\nmanual'.grey + ' limit ' + 'BUY'.green + ' command executed'.grey)
                      } else if (key === 'B' && !info.ctrl) {
                        engine.executeSignal('buy', null, null, false, true)
                        console.log('\nmanual'.grey + ' market ' + 'BUY'.green + ' command executed'.grey)
                      } else if (key === 's' && !info.ctrl) {
                        engine.executeSignal('sell')
                        console.log('\nmanual'.grey + ' limit ' + 'SELL'.red + ' command executed'.grey)
                      } else if (key === 'S' && !info.ctrl) {
                        engine.executeSignal('sell', null, null, false, true)
                        console.log('\nmanual'.grey + ' market ' + 'SELL'.red + ' command executed'.grey)
                      } else if ((key === 'c' || key === 'C') && !info.ctrl) {
                        delete s.buy_order
                        delete s.sell_order
                        console.log('\nmanual'.grey + ' order cancel' + ' command executed'.grey)
                      } else if (key === 'm' && !info.ctrl && so.mode === 'live') {
                        so.manual = !so.manual
                        console.log('\nMANUAL trade in LIVE mode: ' + (so.manual ? 'ON'.green.inverse : 'OFF'.red.inverse))
                      } else if (key === 'T' && !info.ctrl) {
                        so.order_type = 'taker'
                        console.log('\n' + 'Taker fees activated'.bgRed)
                      } else if (key === 'M' && !info.ctrl) {
                        so.order_type = 'maker'
                        console.log('\n' + 'Maker fees activated'.black.bgGreen)
                      } else if (key === 'o' && !info.ctrl) {
                        listOptions()
                      } else if (key === 'O' && !info.ctrl) {
                        console.log('\n' + cliff.inspect(so))
                      } else if (key === 'P' && !info.ctrl) {
                        console.log('\nWriting statistics...'.grey)
                        printTrade(false)
                      } else if (key === 'X' && !info.ctrl) {
                        console.log('\nExiting... ' + '\nWriting statistics...'.grey)
                        printTrade(true)
                      } else if (key === 'd' && !info.ctrl) {
                        console.log('\nDumping statistics...'.grey)
                        printTrade(false, true)
                      } else if (key === 'D' && !info.ctrl) {
                        console.log('\nDumping statistics...'.grey)
                        toggleStats()
                      } else if (key === 'L' && !info.ctrl) {
                        so.debug = !so.debug
                        console.log('\nDEBUG mode: ' + (so.debug ? 'ON'.green.inverse : 'OFF'.red.inverse))
                      } else if (info.name === 'c' && info.ctrl) {
                        // @todo: cancel open orders before exit
                        console.log()
                        process.exit()
                      }
                    })
                  }
                })
              })
              return
            }
            db_cursor = trades[trades.length - 1].time
            trade_cursor = s.exchange.getCursor(trades[trades.length - 1])
            engine.update(trades, true, function (err) {
              if (err) throw err
              setImmediate(getNext)
            })
          })
        }
        engine.writeHeader()
        getNext()
      })

      var prev_timeout = null
      function forwardScan () {
        function saveSession () {
          engine.syncBalance(function (err) {
            if (!err && s.balance.asset === undefined) {
              // TODO not the nicest place to verify the state, but did not found a better one
              throw new Error('Error during syncing balance. Please check your API-Key')
            }
            if (err) {
              console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error syncing balance')
              if (err.desc) console.error(err.desc)
              if (err.body) console.error(err.body)
              console.error(err)
            }
            if (botStartTime && botStartTime - moment() < 0 ) {
              // Not sure if I should just handle exit code directly or thru printTrade.  Decided on printTrade being if code is added there for clean exits this can just take advantage of it.
              engine.exit(() => {
                printTrade(true)
              })
            }
            session.updated = new Date().getTime()
            session.balance = s.balance
            session.start_capital = s.start_capital
            session.start_price = s.start_price
            session.num_trades = s.my_trades.length
            if (!session.orig_capital) session.orig_capital = s.start_capital
            if (!session.orig_price) session.orig_price = s.start_price
            if (s.period) {
              session.price = s.period.close
              var d = tb().resize(conf.balance_snapshot_period)
              var b = {
                id: so.selector.normalized + '-' + d.toString(),
                selector: so.selector.normalized,
                time: d.toMilliseconds(),
                currency: s.balance.currency,
                asset: s.balance.asset,
                price: s.period.close,
                start_capital: session.orig_capital,
                start_price: session.orig_price,
              }
              b._id = b.id
              b.consolidated = n(s.balance.asset).multiply(s.period.close).add(s.balance.currency).value()
              b.profit = (b.consolidated - session.orig_capital) / session.orig_capital
              b.buy_hold = s.period.close * (session.orig_capital / session.orig_price)
              b.buy_hold_profit = (b.buy_hold - session.orig_capital) / session.orig_capital
              b.vs_buy_hold = (b.consolidated - b.buy_hold) / b.buy_hold
              conf.output.api.on && printTrade(false, false, true)
              if (so.mode === 'live') {
                balances.save(b, function (err) {
                  if (err) {
                    console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving balance')
                    console.error(err)
                  }
                })
              }
              session.balance = b
            }
            else {
              session.balance = {
                currency: s.balance.currency,
                asset: s.balance.asset
              }
            }
            sessions.save(session, function (err) {
              if (err) {
                console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving session')
                console.error(err)
              }
              if (s.period) {
                engine.writeReport(true)
              } else {
                readline.clearLine(process.stdout)
                readline.cursorTo(process.stdout, 0)
                process.stdout.write('Waiting on first live trade to display reports, could be a few minutes ...')
              }
            })
          })
        }
        var opts = {product_id: so.selector.product_id, from: trade_cursor}
        s.exchange.getTrades(opts, function (err, trades) {
          if (err) {
            if (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
              if (prev_timeout) {
                console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - getTrades request timed out. retrying...')
              }
              prev_timeout = true
            }
            else if (err.code === 'HTTP_STATUS') {
              if (prev_timeout) {
                console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - getTrades request failed: ' + err.message + '. retrying...')
              }
              prev_timeout = true
            }
            else {
              console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - getTrades request failed. retrying...')
              console.error(err)
            }
            return
          }
          prev_timeout = null
          if (trades.length) {
            trades.sort(function (a, b) {
              if (a.time > b.time) return -1
              if (a.time < b.time) return 1
              return 0
            })
            trades.forEach(function (trade) {
              var this_cursor = s.exchange.getCursor(trade)
              trade_cursor = Math.max(this_cursor, trade_cursor)
              saveTrade(trade)
            })
            engine.update(trades, function (err) {
              if (err) {
                console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving session')
                console.error(err)
              }
              resume_markers.save(marker, function (err) {
                if (err) {
                  console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving marker')
                  console.error(err)
                }
              })
              if (s.my_trades.length > my_trades_size) {
                s.my_trades.slice(my_trades_size).forEach(function (my_trade) {
                  my_trade.id = crypto.randomBytes(4).toString('hex')
                  my_trade._id = my_trade.id
                  my_trade.selector = so.selector.normalized
                  my_trade.session_id = session.id
                  my_trade.mode = so.mode
                  my_trades.save(my_trade, function (err) {
                    if (err) {
                      console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving my_trade')
                      console.error(err)
                    }
                  })
                })
                my_trades_size = s.my_trades.length
              }
              function savePeriod (period) {
                if (!period.id) {
                  period.id = crypto.randomBytes(4).toString('hex')
                  period.selector = so.selector.normalized
                  period.session_id = session.id
                }
                period._id = period.id
                periods.save(period, function (err) {
                  if (err) {
                    console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving my_trade')
                    console.error(err)
                  }
                })
              }
              if (s.lookback.length > lookback_size) {
                savePeriod(s.lookback[0])
                lookback_size = s.lookback.length
              }
              if (s.period) {
                savePeriod(s.period)
              }
              saveSession()
            })
          }
          else {
            saveSession()
          }
        })
        function saveTrade (trade) {
          trade.id = so.selector.normalized + '-' + String(trade.trade_id)
          trade.selector = so.selector.normalized
          if (!marker.from) {
            marker.from = trade_cursor
            marker.oldest_time = trade.time
            marker.newest_time = trade.time
          }
          marker.to = marker.to ? Math.max(marker.to, trade_cursor) : trade_cursor
          marker.newest_time = Math.max(marker.newest_time, trade.time)
          trades.save(trade, function (err) {
            // ignore duplicate key errors
            if (err && err.code !== 11000) {
              console.error('\n' + moment().format('YYYY-MM-DD HH:mm:ss') + ' - error saving trade')
              console.error(err)
            }
          })
        }
      }
    })
}

