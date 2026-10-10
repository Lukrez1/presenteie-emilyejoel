export type GiftStatus = 'available' | 'reserved' | 'received';
export type ReservationStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled';

export interface Gift {
  id?: number;
  source_id: number;
  name: string;
  category: string;
  brand: string | null;
  price: number;
  quantity: number;
  giver: string | null;
  received: boolean;
  thanked: boolean;
  notes: string | null;
  description: string;
  image_url?: string | null;
  status: GiftStatus;
  sort_order: number;
  contributed_amount?: number;
  confirmed_contributions_total?: number;
  created_at?: string;
  updated_at?: string;
  gift_type?: string;
}

export interface ReservationRequest {
  id: string;
  request_code: string;
  gift_id: number;
  status: ReservationStatus;
  admin_notes: string | null;
  created_at: string;
  confirmed_at: string | null;
  rejected_at: string | null;
  gift?: Gift;
}

export interface GiftContribution {
  id: string;
  request_code: string;
  gift_id: number | null;
  amount: number;
  status: ReservationStatus;
  created_at: string;
  confirmed_at: string | null;
  rejected_at: string | null;
  gift?: Gift;
}
