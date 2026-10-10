/**
 * Carrier abstraction. Today only the manual carrier exists (the admin types the carrier name and
 * tracking number). A real integration (Bosta, Aramex, ...) implements this interface later and is
 * registered in CarrierRegistry without touching the order flow.
 */
export interface CreateShipmentRequest {
  orderNumber: string;
  recipientName: string;
  phone: string;
  governorate: string;
  city: string;
  address: string;
  codAmount: number;
}

export interface CreatedShipment {
  trackingNumber: string | null;
  trackingUrl: string | null;
}

export interface Carrier {
  readonly key: string;
  readonly label: string;
  /** Automatic carriers create the waybill themselves. Manual ones return null (admin enters it). */
  createShipment(request: CreateShipmentRequest): Promise<CreatedShipment | null>;
  buildTrackingUrl(trackingNumber: string): string | null;
}

export class ManualCarrier implements Carrier {
  readonly key = 'manual';
  readonly label = 'Manual';

  async createShipment(): Promise<CreatedShipment | null> {
    return null;
  }

  buildTrackingUrl(): string | null {
    return null;
  }
}

export class CarrierRegistry {
  private readonly carriers = new Map<string, Carrier>();

  constructor(carriers: Carrier[] = [new ManualCarrier()]) {
    for (const c of carriers) this.carriers.set(c.key, c);
  }

  get(key: string): Carrier {
    return this.carriers.get(key) ?? this.carriers.get('manual')!;
  }

  register(carrier: Carrier): void {
    this.carriers.set(carrier.key, carrier);
  }
}
