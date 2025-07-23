import { request } from 'undici';

const URL = process.env.VECTOR_URL || 'http://localhost:7001';

export async function vecAdd(rowId, text) {
  try {
    await request(URL + '/add', {
      method: 'POST',
      body: JSON.stringify({ row_id: rowId, text }),
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) { console.error('vecAdd', e); }
}

export async function vecQuery(text, k = 3) {
  try {
    const { body } = await request(URL + '/query', {
      method: 'POST',
      body: JSON.stringify({ text, k }),
      headers: { 'content-type': 'application/json' }
    });
    return (await body.json()).ids;          // [rowId, ...]
  } catch (e) { console.error('vecQuery', e); return []; }
}
