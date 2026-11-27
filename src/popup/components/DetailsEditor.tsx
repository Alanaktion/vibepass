/** Editor sections for cards and identities. EditView owns the draft and saving. */
import { Eye, EyeOff } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { CARD_BRANDS, cardBrand } from '../../vault/draft';
import type { CardDraft, IdentityDraft, IdentityFieldName } from '../../vault/types';
import { IconButton } from './IconButton';

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const TITLES = ['Mr', 'Mrs', 'Ms', 'Mx', 'Dr'];

/** A text input that can hide its value. Same element either way, so focus stays put. */
export function SecretInput(props: {
  shown: boolean;
  value: string;
  onValue: (value: string) => void;
  id?: string;
  class?: string | undefined;
  label?: string;
  placeholder?: string;
  autocomplete: string;
  inputMode?: 'numeric' | 'text';
}) {
  const common = {
    id: props.id,
    class: props.class,
    value: props.value,
    'aria-label': props.label,
    placeholder: props.placeholder,
    autocomplete: props.autocomplete,
    inputMode: props.inputMode,
    spellcheck: false,
    onInput: (e: Event) => {
      props.onValue((e.currentTarget as HTMLInputElement).value);
    },
  };
  return props.shown ? <input type="text" {...common} /> : <input type="password" {...common} />;
}

/** A labeled concealed value with its own show and hide button. */
function SecretField(props: {
  id: string;
  label: string;
  value: string;
  onValue: (value: string) => void;
  inputMode?: 'numeric' | 'text';
}) {
  const [shown, setShown] = useState(false);
  return (
    <div class="labelled">
      <label for={props.id}>{props.label}</label>
      <div class="row input-row">
        <SecretInput
          id={props.id}
          class="grow mono"
          shown={shown}
          value={props.value}
          autocomplete="off"
          {...(props.inputMode ? { inputMode: props.inputMode } : {})}
          onValue={props.onValue}
        />
        <IconButton
          icon={shown ? EyeOff : Eye}
          label={`${shown ? 'Hide' : 'Show'} ${props.label.toLowerCase()}`}
          onClick={() => {
            setShown((s) => !s);
          }}
        />
      </div>
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onValue: (value: string) => void;
  type?: 'email' | 'tel';
  class?: string;
}) {
  const common = {
    value: props.value,
    autocomplete: 'off',
    spellcheck: false,
    onInput: (e: Event) => {
      props.onValue((e.currentTarget as HTMLInputElement).value);
    },
  };
  return (
    <label class={props.class}>
      {props.label}
      {props.type === 'email' ? (
        <input type="email" {...common} />
      ) : props.type === 'tel' ? (
        <input type="tel" {...common} />
      ) : (
        <input type="text" {...common} />
      )}
    </label>
  );
}

/** Cardholder, number, brand, expiration, and security code. */
export function CardFields({
  card,
  onChange,
}: {
  card: CardDraft;
  onChange: (patch: Partial<CardDraft>) => void;
}) {
  // Keep an unknown brand from another client selectable rather than dropping it.
  const brands: readonly string[] =
    card.brand && !CARD_BRANDS.includes(card.brand as (typeof CARD_BRANDS)[number])
      ? [...CARD_BRANDS, card.brand]
      : CARD_BRANDS;
  return (
    <fieldset>
      <legend>Card</legend>
      <TextField
        label="Cardholder name"
        value={card.cardholderName}
        onValue={(cardholderName) => {
          onChange({ cardholderName });
        }}
      />
      <SecretField
        id="edit-card-number"
        label="Number"
        value={card.number}
        inputMode="numeric"
        onValue={(number) => {
          // Fill in the brand from the number, unless the user picked a different one.
          const guessed = cardBrand(card.number) ?? '';
          const patch: Partial<CardDraft> = { number };
          if (card.brand === '' || card.brand === guessed) patch.brand = cardBrand(number) ?? '';
          onChange(patch);
        }}
      />
      <div class="labelled">
        <label for="edit-card-brand">Brand</label>
        <select
          id="edit-card-brand"
          value={card.brand}
          onChange={(e) => {
            onChange({ brand: e.currentTarget.value });
          }}
        >
          <option value="">Choose…</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
      <div class="row">
        <div class="labelled grow">
          <label for="edit-card-month">Expiration month</label>
          <select
            id="edit-card-month"
            value={card.expMonth}
            onChange={(e) => {
              onChange({ expMonth: e.currentTarget.value });
            }}
          >
            <option value="">Month</option>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {m.padStart(2, '0')}
              </option>
            ))}
            {card.expMonth && !MONTHS.includes(card.expMonth) && (
              <option value={card.expMonth}>{card.expMonth}</option>
            )}
          </select>
        </div>
        <label class="grow">
          Expiration year
          <input
            value={card.expYear}
            inputMode="numeric"
            placeholder="YYYY"
            maxLength={4}
            autocomplete="off"
            onInput={(e) => {
              onChange({ expYear: e.currentTarget.value });
            }}
          />
        </label>
      </div>
      <SecretField
        id="edit-card-code"
        label="Security code"
        value={card.code}
        inputMode="numeric"
        onValue={(code) => {
          onChange({ code });
        }}
      />
    </fieldset>
  );
}

/** Name, contact, address, and identity documents. */
export function IdentityFields({
  identity,
  onChange,
}: {
  identity: IdentityDraft;
  onChange: (patch: Partial<IdentityDraft>) => void;
}) {
  const text = (key: IdentityFieldName, label: string, type?: 'email' | 'tel', grow = false) => (
    <TextField
      label={label}
      {...(grow ? { class: 'grow' } : {})}
      value={identity[key]}
      {...(type ? { type } : {})}
      onValue={(value) => {
        onChange({ [key]: value });
      }}
    />
  );
  const secret = (key: IdentityFieldName, label: string) => (
    <SecretField
      id={`edit-identity-${key}`}
      label={label}
      value={identity[key]}
      onValue={(value) => {
        onChange({ [key]: value });
      }}
    />
  );
  const titles =
    identity.title && !TITLES.includes(identity.title) ? [...TITLES, identity.title] : TITLES;
  return (
    <>
      <fieldset>
        <legend>Personal</legend>
        <div class="row">
          <div class="labelled narrow">
            <label for="edit-identity-title">Title</label>
            <select
              id="edit-identity-title"
              value={identity.title}
              onChange={(e) => {
                onChange({ title: e.currentTarget.value });
              }}
            >
              <option value="">None</option>
              {titles.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          {text('firstName', 'First name', undefined, true)}
        </div>
        <div class="row">
          {text('middleName', 'Middle name', undefined, true)}
          {text('lastName', 'Last name', undefined, true)}
        </div>
        <div class="row">
          {text('username', 'Username', undefined, true)}
          {text('company', 'Company', undefined, true)}
        </div>
      </fieldset>
      <fieldset>
        <legend>Contact</legend>
        <div class="row">
          {text('email', 'Email', 'email', true)}
          {text('phone', 'Phone', 'tel', true)}
        </div>
      </fieldset>
      <fieldset>
        <legend>Address</legend>
        {text('address1', 'Address line 1')}
        {text('address2', 'Address line 2')}
        {text('address3', 'Address line 3')}
        <div class="row">
          {text('city', 'City or town', undefined, true)}
          {text('country', 'Country', undefined, true)}
        </div>
        <div class="row">
          <TextField
            class="grow"
            label="State or province"
            value={identity.state}
            onValue={(state) => {
              onChange({ state });
            }}
          />
          <TextField
            class="grow"
            label="Postal code"
            value={identity.postalCode}
            onValue={(postalCode) => {
              onChange({ postalCode });
            }}
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>Documents</legend>
        {secret('ssn', 'Social Security number')}
        {secret('passportNumber', 'Passport number')}
        {secret('licenseNumber', 'License number')}
      </fieldset>
    </>
  );
}
