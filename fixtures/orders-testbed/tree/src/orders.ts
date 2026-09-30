export async function listOrders() {
  const response = await fetch("https://orders.example.test/orders");
  return response.json();
}
