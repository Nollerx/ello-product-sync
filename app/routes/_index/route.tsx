import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import {
  AOV_DEFAULT,
  OVERAGE_USD_PER_TRYON,
  PRICING_PLANS,
  breakEvenOrders,
  formatMoney,
} from "../../lib/pricing-plans";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const [averageOrderValue, setAverageOrderValue] = useState(AOV_DEFAULT);

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <img
          className={styles.heroImage}
          src="/onboarding/welcome-hero.webp"
          alt="Ello Virtual Try On product example"
        />
        <div className={styles.heroOverlay} />
        <nav className={styles.nav}>
          <span className={styles.brand}>Ello Virtual Try On</span>
          <a className={styles.navLink} href="#pricing">Pricing</a>
        </nav>
        <div className={styles.heroContent}>
          <p className={styles.kicker}>Shopify virtual try-on for clothing brands</p>
          <h1>Let shoppers see the fit before they buy.</h1>
          <p>
            Ello helps apparel stores turn fit uncertainty into purchase confidence with AI virtual try-on.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryButton} href="#pricing">See pricing</a>
            <a className={styles.secondaryButton} href="mailto:andrew@ello.services?subject=Ello%20demo">Contact Andrew</a>
          </div>
        </div>
      </section>

      <section className={styles.pricingSection} id="pricing">
        <div className={styles.sectionHeader}>
          <p className={styles.kicker}>Pricing</p>
          <h2>Start small, then move into real store traffic.</h2>
          <p>Free tier for testing, four main paid plans, and custom Enterprise when usage needs a manual setup.</p>
        </div>

        <div className={styles.calculator}>
          <div>
            <span className={styles.calculatorLabel}>Average order value</span>
            <label className={styles.aovField}>
              <span>$</span>
              <input
                type="number"
                min="1"
                step="1"
                value={averageOrderValue}
                onChange={(event) => setAverageOrderValue(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <p>
            At {formatMoney(averageOrderValue || AOV_DEFAULT)} AOV, the plan cards show how many added purchases
            cover the monthly subscription.
          </p>
        </div>

        <div className={styles.planGrid}>
          <article className={styles.planCard}>
            <div className={styles.planTopline}>
              <h3>Free</h3>
              <span>Test install</span>
            </div>
            <p className={styles.price}>$0<span>/mo</span></p>
            <p className={styles.usage}>10 try-ons per month</p>
            <p className={styles.breakEven}>Install, test, and confirm Ello works on your storefront.</p>
            {showForm && (
              <Form className={styles.installForm} method="post" action="/auth/login">
                <input className={styles.shopInput} type="text" name="shop" placeholder="your-store.myshopify.com" />
                <button className={styles.planButton} type="submit">Install</button>
              </Form>
            )}
          </article>

          {PRICING_PLANS.map((plan) => {
            const orders = breakEvenOrders(plan.monthlyPrice, averageOrderValue);
            return (
              <article
                className={`${styles.planCard} ${plan.featured ? styles.featuredPlan : ""}`}
                key={plan.key}
              >
                <div className={styles.planTopline}>
                  <h3>{plan.displayName}</h3>
                  <span>{plan.positioning}</span>
                </div>
                <p className={styles.price}>{formatMoney(plan.monthlyPrice)}<span>/mo</span></p>
                <p className={styles.usage}>{plan.includedTryons.toLocaleString()} try-ons per month</p>
                <p className={styles.breakEven}>
                  Needs {orders ?? "-"} added {orders === 1 ? "purchase" : "purchases"} at {formatMoney(averageOrderValue || AOV_DEFAULT)} AOV.
                </p>
                <p className={styles.overage}>${OVERAGE_USD_PER_TRYON.toFixed(2)} per extra try-on</p>
                <a className={styles.planButton} href="/app/billing">Start 7-day trial</a>
              </article>
            );
          })}

          <article className={styles.planCard}>
            <div className={styles.planTopline}>
              <h3>Enterprise</h3>
              <span>Manual</span>
            </div>
            <p className={styles.price}>Custom</p>
            <p className={styles.usage}>Custom try-on volume</p>
            <p className={styles.breakEven}>For high-volume brands that need procurement, custom caps, or manual rollout support.</p>
            <a className={styles.planButton} href="mailto:andrew@ello.services?subject=Ello%20Enterprise%20plan">
              Contact for Enterprise
            </a>
          </article>
        </div>
      </section>
    </main>
  );
}
