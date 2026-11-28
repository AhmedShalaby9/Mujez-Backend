import assert from "node:assert/strict";
import test from "node:test";
import { propertySchema } from "../dist/modules/office/office.schema.js";

const base = {
  title: "Clinic 12",
  ownerName: "Owner",
  ownerPhones: ["+201001234567"],
  cityId: "00000000-0000-4000-8000-000000000001",
  areaName: "Maadi",
  address: "Street 1",
  type: "clinic",
  purpose: "sale",
  furnishing: "unfurnished",
  area: 80,
  saleMinor: "200000000",
  listingType: "sale_installments",
  downPaymentMinor: "50000000",
  groupName: "Group A",
  buildingNumber: "4",
  unitNumber: "12",
  additions: "Parking",
  deliveryYear: 2028,
};

test("office property accepts the new clinic and installment details", () => {
  const result = propertySchema.parse(base);
  assert.equal(result.type, "clinic");
  assert.equal(result.downPaymentMinor, "50000000");
  assert.equal(result.deliveryYear, 2028);
  assert.equal(
    propertySchema.safeParse({
      ...base,
      listingType: "sale_cash",
      downPaymentMinor: null,
    }).success,
    true,
  );
  assert.equal(
    propertySchema.safeParse({
      ...base,
      listingType: "rent_furnished",
      purpose: "rent",
      furnishing: "furnished",
      saleMinor: null,
      rentMinor: "1000000",
      downPaymentMinor: null,
    }).success,
    true,
  );
});

test("office property rejects invalid payment and furnished rent combinations", () => {
  assert.equal(
    propertySchema.safeParse({ ...base, downPaymentMinor: "300000000" })
      .success,
    false,
  );
  assert.equal(
    propertySchema.safeParse({ ...base, listingType: "sale_cash" }).success,
    false,
  );
  assert.equal(
    propertySchema.safeParse({
      ...base,
      listingType: "rent_furnished",
      purpose: "rent",
      saleMinor: null,
      rentMinor: "1000000",
      downPaymentMinor: null,
    }).success,
    false,
  );
});
