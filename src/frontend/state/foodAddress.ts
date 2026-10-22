// The delivery addressId the Food tab is currently using, for components that
// need to call a Food route on their own (e.g. the dish customizer loading a
// dish's variant / add-on options) without threading the id through every
// parent. Set by useSwiggyChat whenever the selected address changes.

let currentFoodAddressId = "";

export function setFoodAddressId(addressId: string): void {
  currentFoodAddressId = addressId;
}

export function getFoodAddressId(): string {
  return currentFoodAddressId;
}
