"""Geography and trust-layer models.

`Verification` is the platform's trust primitive: every fact-bearing entity
(`Service`, `Fee`, `Requirement`, `Document`, `Agency`, `Office`) can have
zero or more `Verification` rows attached, each pointing at the `Source` it
was checked against. We use a polymorphic association (`entity_type` +
`entity_id`) rather than a separate `*_id` foreign key column per entity —
a dedicated `service_verifications`, `fee_verifications`, ... table per
entity would duplicate identical logic five times over for no behavioral
gain. The tradeoff is that the DB itself can't enforce referential
integrity on `entity_id` (there's no single table it could reference), so
repositories are responsible for only ever writing valid `(entity_type,
entity_id)` pairs — see `app/repositories/knowledge_repository.py`.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Enum, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.db.session import Base


class Country(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A country JKP has knowledge coverage for."""

    __tablename__ = "countries"
    __table_args__ = (UniqueConstraint("iso_code", name="uq_countries_iso_code"),)

    iso_code: Mapped[str] = mapped_column(String(2), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    states: Mapped[list["State"]] = relationship(back_populates="country", passive_deletes=True)


class State(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A first-level administrative division (state/province).

    Nullable on entities that are federal-level rather than state-scoped —
    Nigeria's business registration, for example, is administered
    nationally by the CAC, not per-state.
    """

    __tablename__ = "states"
    __table_args__ = (UniqueConstraint("country_id", "name", name="uq_states_country_name"),)

    country_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("countries.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    code: Mapped[str | None] = mapped_column(String(10), nullable=True)

    country: Mapped["Country"] = relationship(back_populates="states")


class Source(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A citable origin for a fact — an official gazette, an agency website, etc."""

    __tablename__ = "sources"

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(String(1000), nullable=False)
    publisher: Mapped[str] = mapped_column(String(255), nullable=False)
    is_primary: Mapped[bool] = mapped_column(
        default=False, nullable=False, doc="True for official/government sources."
    )
    accessed_at: Mapped[datetime] = mapped_column(nullable=False)


class VerificationStatus(str, enum.Enum):
    VERIFIED = "verified"
    UNVERIFIED = "unverified"
    OUTDATED = "outdated"
    DISPUTED = "disputed"


class VerifiableEntityType(str, enum.Enum):
    AGENCY = "agency"
    OFFICE = "office"
    SERVICE = "service"
    REQUIREMENT = "requirement"
    DOCUMENT = "document"
    FEE = "fee"


class Verification(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A verification record attaching a `Source` and confidence to a fact.

    `entity_type` + `entity_id` identify the fact being verified. See the
    module docstring for why this is polymorphic rather than five separate
    join tables.
    """

    __tablename__ = "verifications"

    entity_type: Mapped[VerifiableEntityType] = mapped_column(
        Enum(VerifiableEntityType, name="verifiable_entity_type"), nullable=False
    )
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sources.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[VerificationStatus] = mapped_column(
        Enum(VerificationStatus, name="verification_status"), nullable=False
    )
    confidence_score: Mapped[float] = mapped_column(
        Numeric(3, 2), nullable=False, doc="0.00–1.00. Higher = more trustworthy."
    )
    verified_at: Mapped[datetime] = mapped_column(nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    source: Mapped["Source"] = relationship()
