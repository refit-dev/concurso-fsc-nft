import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import Stripe from "stripe";

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

export const POST = async (request: Request) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      console.error("Missing Stripe env vars");
      return NextResponse.error();
    }

    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      console.error("Missing Stripe signature");
      return NextResponse.error();
    }

    const text = await request.text();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-09-30.endive",
    });

    const event = stripe.webhooks.constructEvent(
      text,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );

    const clerk = await clerkClient();

    switch (event.type) {
      // Evento para primeira cobrança
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.mode === "subscription") {
          const subscriptionId = session.subscription as string;
          const customerId = session.customer as string;

          if (!subscriptionId) {
            console.error("Missing subscription ID in checkout session");
            return NextResponse.error();
          }

          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId);
          const clerkUserId = subscription.metadata?.clerk_user_id;

          if (!clerkUserId) {
            console.error("Missing clerk_user_id in subscription metadata");
            return NextResponse.error();
          }

          await clerk.users.updateUser(clerkUserId, {
            privateMetadata: {
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
            },
            publicMetadata: {
              subscriptionPlan: "premium",
            },
          });
        }
        break;
      }

      // Evento para cobranças recorrentes
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;

        // Verifica se é uma cobrança recorrente
        if (invoice.billing_reason === "subscription_cycle") {
          const subscriptionId = (getInvoiceSubscription(invoice)) as string;
          const customerId = invoice.customer as string;

          if (!subscriptionId) {
            console.error("Missing subscription ID in invoice");
            return NextResponse.error();
          }

          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId);
          const clerkUserId = subscription.metadata?.clerk_user_id;

          if (!clerkUserId) {
            console.error("Missing clerk_user_id in subscription metadata");
            return NextResponse.error();
          }

          // Garantir que o usuário ainda está premium
          await clerk.users.updateUser(clerkUserId, {
            privateMetadata: {
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
            },
            publicMetadata: {
              subscriptionPlan: "premium",
            },
          });
        }
        break;
      }

      // Cancelamento da subscription - TODO - Painel para gerenciar cancelamentos
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const clerkUserId = subscription.metadata?.clerk_user_id;

        if (!clerkUserId) {
          console.error("Missing clerk_user_id on subscription deletion");
          return NextResponse.error();
        }

        await clerk.users.updateUser(clerkUserId, {
          privateMetadata: {
            stripeCustomerId: null,
            stripeSubscriptionId: null,
          },
          publicMetadata: {
            subscriptionPlan: null,
          },
        });

        break;
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return new NextResponse("Webhook error", { status: 500 });
  }
};
