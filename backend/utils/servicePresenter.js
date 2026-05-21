const toMinutes = (value) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
};

const toServiceResource = (service, options = {}) => {
    const { includeImage = true, includeInternal = true } = options;
    const duration = toMinutes(service.duration ?? service.duration_minutes);
    const image = service.image ?? service.image_url ?? null;

    const resource = {
        id: service.id,
        name: service.name,
        price: service.price,
        duration,
        duration_minutes: duration
    };

    if (service.description !== undefined) resource.description = service.description;
    if (includeImage) {
        resource.image = image;
        resource.image_url = image;
    }

    if (includeInternal) {
        if (service.branch_id !== undefined) resource.branch_id = service.branch_id;
        if (service.owner_id !== undefined) resource.owner_id = service.owner_id;
        if (service.is_active !== undefined) resource.is_active = service.is_active;
    }

    return resource;
};

const toServiceResources = (services, options = {}) =>
    (services || []).map(service => toServiceResource(service, options));

module.exports = {
    toServiceResource,
    toServiceResources
};
