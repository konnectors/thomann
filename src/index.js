process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://3440a1d86e9f42dd91c5c89c6bab4cd4@sentry.cozycloud.cc/115'

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const moment = require('moment')

const request = requestFactory({
  debug: false,
  cheerio: true,
  json: false,
  jar: true
})

const vendor = 'thomann'
const baseUrl = 'https://www.thomann.de'
const loginUrl = `${baseUrl}/intl/mythomann_login.html`
const ordersListUrl = `${baseUrl}/intl/mythomann_orderlist.html`

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
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
function authenticate(username, password) {
  return signin({
    url: loginUrl,
    formSelector: `form[method='post']`,
    formData: {
      uname: username,
      passw: password
    },
    validate: (statusCode, $) => {
      if ($('svg.rs-icon-cc-sb-logout').length === 1) {
        return true
      } else {
        return false
      }
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseDocuments($) {
  const orders = scrape(
    $,
    {
      date: {
        sel: '.order-date',
        parse: parseDate
      },
      number: {
        sel: '.order-nr',
        parse: parseOrderNumber
      },
      amount: {
        sel: '.order-sum',
        parse: parseAmount
      },
      currency: {
        sel: '.order-sum',
        parse: parseCurrency
      },
      details: {
        sel: '.details a',
        attr: 'href'
      }
    },
    '.order-entry'
  )

  let documents = []
  for (let order of orders) {
    const $details = await request(order.details)
    const fileurl = $details('.orderdata a.tr-link-pdf').attr('href')
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
  const nextPage = $('.rs-pagination > .container > .button.next').attr('href')

  if (nextPage) {
    return await request(`${baseUrl}${nextPage}`)
  } else {
    return null
  }
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
