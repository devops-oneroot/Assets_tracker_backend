import nodemailer, { type Transporter } from "nodemailer";
import { ApiError } from "../middleware/errorHandler";
import type { PurchaseOrderApi } from "../models/PurchaseOrder";

/**
 * Sends a purchase order to its vendor by email, over each company's own
 * Google Workspace mailbox.
 *
 * Gmail's SMTP servers reject a From address that isn't the authenticated
 * account, so each entity needs its own mailbox credentials rather than one
 * shared sender with a spoofed From header. A company with no credentials on
 * file gets a clear setup error rather than a silent failure or a send from
 * the wrong address.
 */

interface Mailbox {
  address: string;
  pass: string;
}

/** Every company this dashboard raises orders for, and the mailbox it sends from. */
const MAILBOXES: Record<string, { address: string; envPass: string }> = {
  ENP: { address: "onerootoffice@oneroot.farm", envPass: "SMTP_PASS_ENP" },
  GCC: { address: "accounts@goldcoinsresort.in", envPass: "SMTP_PASS_GCC" },
};

function mailboxFor(entity: string): Mailbox {
  const config = MAILBOXES[entity.toUpperCase()];
  if (!config) {
    throw new ApiError(400, `No mailbox is set up for "${entity}"`);
  }

  // The address is fixed per company; only the app password is read from the
  // environment, so a misconfigured .env can't send a PO from the wrong account.
  const pass = process.env[config.envPass]?.trim();
  if (!pass) {
    throw new ApiError(
      500,
      `Email is not configured for ${entity}. Add ${config.envPass} (a Gmail app password for ${config.address}) to backend/.env.`
    );
  }

  return { address: config.address, pass };
}

const transporters = new Map<string, Transporter>();

function transporterFor(entity: string, mailbox: Mailbox): Transporter {
  const cached = transporters.get(entity);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: mailbox.address, pass: mailbox.pass },
  });
  transporters.set(entity, transporter);
  return transporter;
}

function money(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Emails the PO's PDF to its vendor, from the buying company's own mailbox.
 *
 * The vendor's address is whatever is on file for the supplier — the same
 * contact the order itself was raised against — so there is nothing new to
 * fill in before sending.
 */
export async function sendPurchaseOrderEmail(
  po: PurchaseOrderApi,
  pdf: Buffer
): Promise<{ to: string; from: string }> {
  const to = po.supplier.email.trim();
  if (!to) {
    throw new ApiError(
      400,
      "This supplier has no email address on file — add one before sending the order"
    );
  }

  const mailbox = mailboxFor(po.entity);
  const transporter = transporterFor(po.entity, mailbox);
  const buyerName = po.buyer.name || po.entity;

  const subject = `Purchase Order ${po.poNumber} from ${buyerName}`;
  const text = [
    `Dear ${po.supplier.name || "Sir/Madam"},`,
    "",
    `Please find attached Purchase Order ${po.poNumber}, dated ${
      po.poDate ? new Date(po.poDate).toLocaleDateString("en-IN") : ""
    }, for INR ${money(po.totals.grandTotal)}.`,
    "",
    "Kindly acknowledge receipt and confirm acceptance at your earliest convenience.",
    "",
    "Regards,",
    buyerName,
  ].join("\n");

  const html = `
    <p>Dear ${po.supplier.name || "Sir/Madam"},</p>
    <p>Please find attached Purchase Order <strong>${po.poNumber}</strong>, dated
    ${po.poDate ? new Date(po.poDate).toLocaleDateString("en-IN") : "-"}, for
    <strong>INR ${money(po.totals.grandTotal)}</strong>.</p>
    <p>Kindly acknowledge receipt and confirm acceptance at your earliest convenience.</p>
    <p>Regards,<br/>${buyerName}</p>
  `;

  try {
    await transporter.sendMail({
      from: `"${buyerName}" <${mailbox.address}>`,
      to,
      subject,
      text,
      html,
      attachments: [
        {
          filename: `PO-${(po.poNumber || "purchase-order").replace(/[^A-Za-z0-9._-]/g, "-")}.pdf`,
          content: pdf,
          contentType: "application/pdf",
        },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(502, `Could not send the email: ${message}`);
  }

  return { to, from: mailbox.address };
}
