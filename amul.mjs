// Talks to shop.amul.com. fetchAmulProducts() is deliberately self-contained
// (no closures, no imports) so it can either run in the service worker or be
// injected into a shop.amul.com tab with chrome.scripting.executeScript.

// Amul splits India into regional "substores"; a pincode maps to one of these.
export const SUBSTORES = {
  'goa': '66506005147d6c73c1110115',
  'telangana': '66506004aa64743ceefbed25',
  'pune-br': '66506004a7cddee1b8adb014',
  'solapur-br': '66506004145c16635e6cc914',
  'nashik-br': '66506002c8f2d6e221b91988',
  'aurangabad-br': '66506002aa64743ceefbecf1',
  'chhattisgarh': '66506002998183e1b1935f41',
  'mumbai-br': '66506000c8f2d6e221b9193a',
  'dadra-and-nagar-haveli': '6650600062e3d963520d0bc3',
  'west-bengal': '6650600024e61363e088c526',
  'odisha': '66505ffeaf6a3c7411d2f62c',
  'sikkim': '66505ffe91ab653d60a3df2d',
  'tripura': '66505ffe78117873bb53b6ad',
  'mizoram': '66505ffd998183e1b1935e21',
  'meghalaya': '66505ffd672747740fb389c7',
  'nagaland': '66505ffd24e61363e088c4a5',
  'manipur': '66505ffbf40e263cf5588098',
  'jharkhand': '66505ffb998183e1b1935dee',
  'assam': '66505ffb6510ee3d5903fef8',
  'bihar': '66505ff9af6a3c7411d2f55f',
  'arunachal-pradesh': '66505ff978117873bb53b643',
  'uttar-pradesh-e': '66505ff924e61363e088c414',
  'up-ncr': '66505ff8c8f2d6e221b9180c',
  'uttrakhand': '66505ff8a7cddee1b8adae9d',
  'rajasthan': '66505ff824e61363e088c3dd',
  'jandk': '66505ff6f40e263cf5587fb5',
  'madhya-pradesh': '66505ff6d9346de216752cd7',
  'ladakh': '66505ff6145c16635e6cc7c1',
  'haryana': '66505ff5af6a3c7411d2f4b2',
  'tamil-nadu-1': '66505ff578117873bb53b56a',
  'delhi': '66505ff5145c16635e6cc74d',
  'punjab': '66505ff3998183e1b1935d0e',
  'andhra-pradesh': '66505ff378117873bb53b542',
  'pondicherry': '66505ff312a50963f24870e8',
  'kerala': '66505ff2998183e1b1935ccd',
  'himachal-pradesh': '66505ff26510ee3d5903fda9',
  'chandigarh': '66505ff1672747740fb388ec',
  'karnataka': '66505ff0998183e1b1935c75',
  'gujarat': '66505ff06510ee3d5903fd42',
  'daman-and-diu': '66505ff024e61363e088c306'
}

export const CATEGORIES = ['protein', 'chocolates', 'organic', 'ghee', 'milk']

export async function fetchAmulProducts(pincode, categories, substores, warmUp) {
  const BASE = 'https://shop.amul.com'
  const STORE_ID = '62fa94df8c13af2e242eba16' // Amul's StoreHippo store id
  const FIELDS = [
    'name', 'alias', 'sku', 'price', 'categories', 'available',
    'inventory_quantity', 'inventory_low_stock_quantity',
    'inventory_allow_out_of_stock', 'net_quantity', 'images'
  ]
  const baseHeaders = {
    accept: 'application/json, text/plain, */*',
    frontend: '1',
    base_url: BASE + '/en/browse/protein'
  }
  const get = async (url, headers) => {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store', headers })
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url.split('?')[0])
    return r.text()
  }

  // 1. Cookies (Cloudflare + jsessionid). Skipped when already on the site.
  if (warmUp) await get(BASE + '/en/browse/protein')

  // 2. Session id, used to sign every API call.
  const infoText = await get(BASE + '/user/info.js?_v=' + Date.now())
  const session = JSON.parse(infoText.trim().replace(/^session\s*=\s*/, '').replace(/;\s*$/, ''))
  if (!session.tid) throw new Error('No session id from Amul')

  const sign = async () => {
    const ts = Date.now().toString()
    const rand = Math.floor(1000 * Math.random())
    const bytes = new TextEncoder().encode(STORE_ID + ':' + ts + ':' + rand + ':' + session.tid)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
    return ts + ':' + rand + ':' + hex
  }
  const api = async (url, extra = {}) =>
    JSON.parse(await get(url, { ...baseHeaders, tid: await sign(), ...extra }))

  // 3. Pincode -> regional store.
  const pin = await api(BASE + '/entity/pincode?limit=50&filters[0][field]=pincode&filters[0][value]=' +
    encodeURIComponent(pincode) + '&filters[0][operator]=regex&cf_cache=1h')
  const record = (pin.records || []).find(r => r.pincode === pincode) || (pin.records || [])[0]
  if (!record) throw new Error('Amul does not deliver to pincode ' + pincode)
  const substoreId = substores[record.substore]
  if (!substoreId) throw new Error('Unknown Amul region "' + record.substore + '"')

  const setStore = async () => {
    const r = await fetch(BASE + '/entity/ms.settings/_/setPreferences', {
      method: 'PUT',
      credentials: 'include',
      headers: { ...baseHeaders, 'content-type': 'application/json', tid: await sign() },
      body: JSON.stringify({ data: { store: record.substore } })
    })
    if (!r.ok) throw new Error('HTTP ' + r.status + ' setting store region')
  }
  await setStore()

  // 4. Store version (cache-buster the site itself sends).
  let version = 6
  try {
    const js = await get(BASE + '/ms/store/amul/auto/EN/storeinfo.js')
    const m = js.match(/req\.query\.v\s*=\s*['"]?([^'";\s]+)['"]?/)
    if (m && Number(m[1]) > 0) version = Number(m[1])
  } catch (e) { /* keep default */ }

  // 5. Products. Brackets must stay unencoded or the API returns other inventory.
  const p = new URLSearchParams()
  FIELDS.forEach(f => p.append('fields[' + f + ']', '1'))
  p.append('filters[0][field]', 'categories')
  categories.forEach((c, i) => p.append('filters[0][value][' + i + ']', c))
  p.append('filters[0][operator]', 'in')
  p.append('filters[0][original]', '1')
  p.append('facets', 'true')
  p.append('facetgroup', 'default_category_facet')
  p.append('limit', '200')
  p.append('total', '1')
  p.append('start', '0')
  p.append('v', String(version))
  p.append('device_type', 'other')
  p.append('substore', substoreId)
  const url = BASE + '/api/1/entity/ms.products?' + p.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')

  let res = await api(url)
  if (!Array.isArray(res.data)) throw new Error('Unexpected product response')
  if (res.data.length === 0) { // store preference sometimes needs a second nudge
    await setStore()
    res = await api(url)
  }

  return {
    region: record.substore,
    products: res.data.map(x => ({
      alias: x.alias,
      name: x.name,
      sku: x.sku,
      price: x.price,
      categories: x.categories || [],
      available: x.available,
      inventory_quantity: x.inventory_quantity,
      inventory_low_stock_quantity: x.inventory_low_stock_quantity || 0,
      inventory_allow_out_of_stock: x.inventory_allow_out_of_stock
    }))
  }
}

// Same rule the Amul site uses to show "Add to cart" vs "Sold out".
export function isInStock(p) {
  if (p.inventory_allow_out_of_stock !== undefined && p.inventory_allow_out_of_stock !== null &&
      String(p.inventory_allow_out_of_stock) !== '0') return true
  if (!(p.available > 0)) return false
  const qty = Number(p.inventory_quantity) || 0
  const low = Number(p.inventory_low_stock_quantity) || 0
  return qty > 0 && qty - low > 0
}

export function stockCount(p) {
  const qty = Number(p.inventory_quantity) || 0
  const low = Number(p.inventory_low_stock_quantity) || 0
  return Math.max(0, qty - low)
}

export function productUrl(p) {
  return 'https://shop.amul.com/en/product/' + String(p.alias).replace(/ /g, '')
}
