"""Knowledge-domain models.

These describe *what a government service is and how to complete it* — the
actual answerable content of the platform (e.g. "how do I register a
business in Nigeria"). Fact-level trust (source + confidence) lives
separately in `Verification` (see `geography.py`), attached by
`entity_type` + `entity_id` rather than duplicated onto every table here.
"""

import uuid

from sqlalchemy import Boolean, Computed, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.models.geography import Country
from app.db.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.db.session import Base


class Agency(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A government body responsible for one or more services (e.g. the CAC)."""

    __tablename__ = "agencies"

    country_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("countries.id", ondelete="CASCADE"), nullable=False
    )
    state_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("states.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    short_name: Mapped[str | None] = mapped_column(String(50), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    website: Mapped[str | None] = mapped_column(String(500), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    offices: Mapped[list["Office"]] = relationship(back_populates="agency", passive_deletes=True)
    services: Mapped[list["Service"]] = relationship(back_populates="agency", passive_deletes=True)
    country: Mapped[Country] = relationship()


class Office(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A physical location where an agency's services can be accessed in person."""

    __tablename__ = "offices"

    agency_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False
    )
    state_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("states.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    address_line: Mapped[str] = mapped_column(String(500), nullable=False)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_headquarters: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    agency: Mapped["Agency"] = relationship(back_populates="offices")


class Law(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A statute or regulation that a service's requirements derive their authority from."""

    __tablename__ = "laws"

    country_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("countries.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    short_title: Mapped[str | None] = mapped_column(String(100), nullable=True)
    year_enacted: Mapped[int | None] = mapped_column(nullable=True)
    url: Mapped[str | None] = mapped_column(String(1000), nullable=True)


class Service(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A discrete government service (e.g. "Business Name Registration")."""

    __tablename__ = "services"
    __table_args__ = (
        Index("ix_services_search_vector", "search_vector", postgresql_using="gin"),
    )

    agency_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False
    )
    law_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("laws.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    category: Mapped[str] = mapped_column(
        String(100), nullable=False, doc="e.g. 'business_registration', 'taxation'."
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)
    typical_processing_time: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        doc="Free-text (e.g. 'approximately 7 working days'). Deliberately not a"
        " structured duration — official timelines are rarely precise, and forcing"
        " one implies false certainty. See the linked Verification for how solid"
        " this figure is.",
    )
    version: Mapped[int] = mapped_column(default=1, nullable=False)
    # DB-generated (never written from Python) via `Computed` — always in
    # sync with name/category/description with zero app-level maintenance,
    # since Postgres recomputes it on every row change automatically.
    # `name` is weighted highest ('A'), `category` middle ('B'),
    # `description` lowest ('C') for `ts_rank` ordering in full-text search.
    search_vector: Mapped[str | None] = mapped_column(
        TSVECTOR,
        Computed(
            "setweight(to_tsvector('english', coalesce(name, '')), 'A') || "
            "setweight(to_tsvector('english', coalesce(category, '')), 'B') || "
            "setweight(to_tsvector('english', coalesce(description, '')), 'C')",
            persisted=True,
        ),
        nullable=True,
    )

    agency: Mapped["Agency"] = relationship(back_populates="services")
    law: Mapped["Law | None"] = relationship()
    # `passive_deletes=True` on all three: their FK columns are NOT NULL
    # with `ondelete="CASCADE"` at the DB level (see the migration). Without
    # this, SQLAlchemy's default delete handling tries to null out those
    # FKs in Python before issuing the parent DELETE, which fails outright
    # against a NOT NULL column — `passive_deletes=True` tells it to leave
    # cascading to the database instead, which is already configured to
    # handle it correctly.
    requirements: Mapped[list["Requirement"]] = relationship(
        back_populates="service", order_by="Requirement.sort_order", passive_deletes=True
    )
    fees: Mapped[list["Fee"]] = relationship(back_populates="service", passive_deletes=True)
    service_documents: Mapped[list["ServiceDocument"]] = relationship(
        back_populates="service", passive_deletes=True
    )


class Requirement(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A step or condition that must be satisfied to complete a `Service`."""

    __tablename__ = "requirements"

    service_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("services.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_mandatory: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)

    service: Mapped["Service"] = relationship(back_populates="requirements")


class Document(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A reusable document type (e.g. "Valid means of ID", "Passport photograph").

    Deliberately not owned by a single `Service` — the same document type
    (a passport photo, a valid ID) is required across many services, and
    modeling it as a shared entity linked via `ServiceDocument` avoids
    duplicating "what is a valid ID" five times over.
    """

    __tablename__ = "documents"

    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


class ServiceDocument(TimestampMixin, Base):
    """Association object: which documents a service requires, and whether each is mandatory.

    Modeled as a full association object (not a bare `secondary=` table)
    specifically so `is_mandatory` and `notes` are reachable from ORM
    queries — "is this document required or optional for this service" is
    exactly the kind of fact the `/v1/services/{id}` endpoint must answer,
    so it can't be a second-class column no one can easily read back.
    """

    __tablename__ = "service_documents"

    service_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("services.id", ondelete="CASCADE"), primary_key=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    is_mandatory: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    service: Mapped["Service"] = relationship(back_populates="service_documents")
    document: Mapped["Document"] = relationship()


class Fee(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A monetary cost associated with a `Service` (e.g. name reservation fee)."""

    __tablename__ = "fees"

    service_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("services.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, doc="ISO 4217, e.g. 'NGN'.")
    is_mandatory: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    service: Mapped["Service"] = relationship(back_populates="fees")
