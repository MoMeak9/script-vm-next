// Reference business rules: integer cents, member discount, shipping threshold.
// Taxes, currency conversion and payment processing are outside this example.
export function priceOrder(order) {
  let subtotal = 0;
  for (const item of order.items) {
    if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0 ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new RangeError('Invalid order item');
    }
    subtotal += item.unitPriceCents * item.quantity;
    if (!Number.isSafeInteger(subtotal)) throw new RangeError('Order total overflow');
  }
  const discount = order.member ? Math.floor(subtotal / 10) : 0;
  const discounted = subtotal - discount;
  const shipping = discounted === 0 || discounted >= 10000 ? 0 : 500;
  const total = discounted + shipping;
  if (!Number.isSafeInteger(total)) throw new RangeError('Order total overflow');
  return { subtotal, discount, shipping, total };
}
