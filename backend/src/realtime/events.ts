import type { Order } from "../types";

export interface RealtimeMessage {
  rooms: string[];
  event: string;
  data: unknown;
}
export type Publisher = (m: RealtimeMessage) => void;

export const room = {
  order: (id: string) => `order:${id}`,
  customer: (userId: string) => `customer:${userId}`,
  vendor: (vendorId: string) => `vendor:${vendorId}`,
  courier: (userId: string) => `courier:${userId}`,
  admin: "admin",
  couriersOnline: "couriers:online",
};

export function orderRooms(o: Order): string[] {
  const r = [room.order(o.id), room.customer(o.customerId), room.vendor(o.vendorId), room.admin];
  if (o.courierId) r.push(room.courier(o.courierId));
  return r;
}
