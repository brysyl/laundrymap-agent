export type Role = "CUSTOMER" | "VENDOR" | "COURIER" | "ADMIN";
export interface User { id: string; email: string; phone: string; name: string; role: Role; status: string }
export interface OrderItem { id: string; name: string; quantity: number; unitPriceKobo: number }
export interface Order {
  id: string; customerId: string; vendorId: string; courierId: string | null; status: string;
  subtotalKobo: number; deliveryFeeKobo: number; totalKobo: number; dropoffAddress: string;
  acceptDeadline: string | null; cancelReason: string | null; version: number; createdAt: string; updatedAt: string; items: OrderItem[];
}
export interface Vendor { id: string; name: string; address: string; lat: number; lng: number; unitPriceKobo: number; distanceM?: number; status?: string; ownerId?: string }
export interface Courier { id: string; userId: string; status: string }
