"""Pydantic schemas for the knowledge domain — both response shapes (ORM →
API) and, since Milestone 4, write/input schemas for the authenticated
create/update endpoints under `/v1/services`.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.db.models.geography import VerificationStatus


class SourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    url: str
    publisher: str
    is_primary: bool
    accessed_at: datetime


class VerificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    status: VerificationStatus
    confidence_score: float
    verified_at: datetime
    notes: str | None
    source: SourceOut


class OfficeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    address_line: str
    city: str | None
    phone: str | None
    email: str | None
    is_headquarters: bool


class AgencySummaryOut(BaseModel):
    """Lightweight agency reference, embedded inside `Service` responses."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    short_name: str | None


class AgencyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    short_name: str | None
    description: str | None
    website: str | None
    phone: str | None
    email: str | None
    offices: list[OfficeOut] = []


class LawOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    short_title: str | None
    year_enacted: int | None
    url: str | None


class RequirementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    is_mandatory: bool
    sort_order: int
    verifications: list[VerificationOut] = []


class DocumentOut(BaseModel):
    """A document required by a service, including whether it's mandatory.

    Assembled from `ServiceDocument` (the association object), not directly
    from `Document` — `is_mandatory`/`notes` live on the association, not
    on the document type itself, since the same document can be mandatory
    for one service and optional for another.
    """

    id: uuid.UUID
    name: str
    description: str | None
    is_mandatory: bool
    notes: str | None


class FeeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    amount: float
    currency: str
    is_mandatory: bool
    description: str | None
    verifications: list[VerificationOut] = []


class ServiceSummaryOut(BaseModel):
    """Lightweight service shape for list endpoints."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    category: str
    description: str
    agency: AgencySummaryOut


class CategoryCoverageOut(BaseModel):
    category: str
    service_count: int


class CountryCoverageOut(BaseModel):
    country_iso_code: str
    country_name: str
    categories: list[CategoryCoverageOut]


class ServiceDetailOut(BaseModel):
    """Full answer to "how do I complete this service" — the platform's core payload."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    category: str
    description: str
    typical_processing_time: str | None
    version: int
    agency: AgencyOut
    law: LawOut | None
    requirements: list[RequirementOut]
    fees: list[FeeOut]
    documents: list[DocumentOut]


# --- Write schemas (Milestone 4) ---


class ServiceCreate(BaseModel):
    agency_id: uuid.UUID
    law_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=255)
    slug: str = Field(
        min_length=1,
        max_length=255,
        pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$",
        description="URL-safe identifier, e.g. 'ng-business-name-registration'.",
    )
    category: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1)
    typical_processing_time: str | None = None


class ServiceUpdate(BaseModel):
    """All fields optional — only fields actually present in the request are applied.

    Distinguishing "field omitted" from "field explicitly set to null" is
    exactly why this doesn't just reuse `ServiceCreate` with everything
    made optional: the endpoint reads `model_dump(exclude_unset=True)` so a
    request that omits `typical_processing_time` leaves it untouched, while
    one that sends `"typical_processing_time": null` clears it.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    category: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, min_length=1)
    typical_processing_time: str | None = None


class RequirementCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    is_mandatory: bool = True
    sort_order: int = 0


class FeeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    amount: float = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3, description="ISO 4217, e.g. 'NGN'.")
    is_mandatory: bool = True
    description: str | None = None
