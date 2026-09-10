/**
 * The buyer side of a purchase order: who is placing the order, and the address
 * and GSTN that must appear on the printed document.
 *
 * These are defaults only. Every PO stores its own copy of the buyer block, so a
 * document issued last year keeps the address it was issued with even after the
 * company moves.
 */
export interface PartyDoc {
  name: string;
  address: string;
  gstNumber: string;
}

export const BUYER_PROFILES: Record<string, PartyDoc> = {
  GCC: {
    name: "GOLD COINS CLUB",
    address:
      "SY NO. 45/1, ANDAPURA VILLAGE, ATTIBELE HOBLI, ANEKAL TALUK, ELECTRONIC CITY POST, Bengaluru (Bangalore) Urban, Karnataka, 560100",
    gstNumber: "29AAAAG1219N1ZM",
  },
  ENP: {
    name: "ENP",
    address: "",
    gstNumber: "",
  },
};

export const buyerProfile = (entity: string): PartyDoc =>
  BUYER_PROFILES[entity] ?? { name: entity, address: "", gstNumber: "" };
