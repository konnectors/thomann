process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://13780aa74be2478d92218bd72b421c4e@errors.cozycloud.cc/16'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const moment = require('moment')

const request = requestFactory({
  debug: false,
  cheerio: true,
  json: false,
  jar: true,
  followAllRedirects: true
})

const vendor = 'thomann'
const baseUrl = 'https://www.thomann.de'
const indexUrl = `${baseUrl}/fr/index.html`
const loginUrl = `${baseUrl}/fr/mythomann_login.html`
const accountUrl = `${baseUrl}/fr/mythomann.html`
const ordersListUrl = `${baseUrl}/fr/mythomann_orderlist.html`

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Access homepage to get initial cookies')
  await request(indexUrl)

  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  let documents = []

  log('info', 'Fetching the list of documents')
  let $ = await request(ordersListUrl)

  while ($) {
    log('info', 'Parsing list of documents')
    const pageDocuments = await parseDocuments($)
    documents.push(...pageDocuments)

    log('info', 'Finding next page')
    $ = await findNextDocumentsPage($)
  }

  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    identifiers: [vendor],
    contentType: 'application/pdf'
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
async function authenticate(username, password) {
  const res = await request(loginUrl, {
    method: 'POST',
    formData: {
      uname: username,
      passw: password,
      loginpermanent: 'on',
      o: loginUrl,
      logintry: '1',
      usezip: '0'
    },
    resolveWithFullResponse: true
  })

  if (res.statusCode === 200 && res.request.uri.href !== accountUrl) {
    throw new Error('LOGIN_FAILED')
  }
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseDocuments($) {
  const orders = scrape(
    $,
    {
      date: {
        sel:
          '.row:nth-child(1) > .column:nth-child(1) > .mythomann-order-teaser__detail > .mythomann-order-teaser__detail-value',
        parse: parseDate
      },
      number: {
        sel:
          '.row:nth-child(1) > .column:nth-child(2) > .mythomann-order-teaser__detail > .mythomann-order-teaser__detail-value',
        parse: parseOrderNumber
      },
      amount: {
        sel:
          '.row:nth-child(2) > .column:nth-child(1) > .mythomann-order-teaser__detail > .mythomann-order-teaser__detail-value',
        parse: parseAmount
      },
      currency: {
        sel:
          '.row:nth-child(2) > .column:nth-child(1) > .mythomann-order-teaser__detail > .mythomann-order-teaser__detail-value',
        parse: parseCurrency
      },
      details: {
        sel: '.mythomann-order-teaser__button-row a',
        attr: 'href'
      }
    },
    '#order-list > .mythomann-order-teaser > .mythomann-order-teaser__details-wrapper > .mythomann-order-teaser__details'
  )

  let documents = []
  for (let order of orders) {
    const $details = await request(order.details)
    const fileurl = $details(
      'a.mythomann-order-history__entry-pdf-button'
    ).attr('href')
    const filename = `${order.date.format(
      'YYYY-MM-DD'
    )}_${vendor}_${order.amount.toFixed(2)}${order.currency}_${
      order.number
    }.pdf`

    documents.push({
      vendor: vendor,
      date: order.date.toDate(),
      amount: order.amount,
      currency: order.currency,
      fileurl: fileurl,
      filename: filename,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    })
  }

  return documents
}

async function findNextDocumentsPage($) {
  const pages = scrape(
    $,
    {
      url: {
        attr: 'href'
      },
      active: {
        attr: 'class',
        parse: classes =>
          classes.indexOf('fx-pagination__pages-button--active') !== -1
      }
    },
    '#order-list > .fx-pagination > .fx-pagination__pages > .fx-pagination__pages-button'
  )

  const activePageIndex = pages.findIndex(element => element.active)
  if (activePageIndex > -1 && activePageIndex < pages.length - 1) {
    const nextPageUrl = pages[activePageIndex + 1].url
    return await request(`${baseUrl}${nextPageUrl}`)
  }

  return null
}

function parseOrderNumber(number) {
  return number.slice(number.lastIndexOf(' ') + 1).trim()
}

function parseAmount(price) {
  const amountStr = price
    .trim()
    .slice(price.indexOf(':') + 1, price.length)
    .slice(0, price.length - 1)
    .replace(',', '.')

  return parseFloat(amountStr)
}

function parseCurrency(price) {
  return price.trim()[price.length - 1]
}

function parseDate(date) {
  const dateStr = date.slice(date.lastIndexOf(' ') + 1, date.length).trim()
  return moment.utc(dateStr, 'DD.MM.YYYY')
}
