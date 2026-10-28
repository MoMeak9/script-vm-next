import { priceOrder } from './pricing.mjs';

console.log(JSON.stringify(priceOrder({
  member: true,
  items: [{ unitPriceCents: 2500, quantity: 2 }],
})));
