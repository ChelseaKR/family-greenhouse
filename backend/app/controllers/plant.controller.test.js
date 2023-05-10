const request = require('supertest');
const db = require('../models');
const app = require('../../app');
const uuid = require('uuid');

describe('Plants Controller', () => {
    beforeAll(async () => {
        await db.sequelize.sync({ force: true });
    });

    afterEach(async () => {
        await db.plants.destroy({ where: {} });
    });

    test('should create a new plant', async () => {
        const userId = (Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1).toString();
        const greenhouse = uuid.v4();
        const waterFrequencyDays = Math.floor(Math.random() * 365) + 1;

        const response = await request(app)
            .post('/api/plants/add')
            .send({
                userId: userId,
                greenhouse: greenhouse,
                name: 'Test Plant',
                type: 'Test Type',
                location: 'Test Location',
                description: 'Test Description',
                water_frequency_days: waterFrequencyDays,
            });

        expect(response.status).toBe(200);
        expect(response.body.plant).toHaveProperty('id');
        expect(response.body.plant.userId).toBe(userId);
        expect(response.body.plant.greenhouse).toBe(greenhouse);
        expect(response.body.plant.name).toBe('Test Plant');
        expect(response.body.plant.type).toBe('Test Type');
        expect(response.body.plant.location).toBe('Test Location');
        expect(response.body.plant.description).toBe('Test Description');
        expect(response.body.plant.water_frequency_days).toBe(waterFrequencyDays);
    });

    test('should get all plants', async () => {
        jest.setTimeout(20000); // Increase timeout value to 10000 ms (10 seconds)
        const userId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
        const greenhouse = uuid.v4();
        const waterFrequencyDays = Math.floor(Math.random() * 365) + 1;

        const plant = {
            userId: userId,
            greenhouse: greenhouse,
            name: 'Test Plant',
            type: 'Test Type',
            location: 'Test Location',
            description: 'Test Description',
            water_frequency_days: waterFrequencyDays,
        };

        console.log('Creating plant...');
        await db.plants.create(plant);
        console.log('Plant created.');
        console.log('Sending request...');
        const response = await request(app).get(`/api/plants?greenhouse=${greenhouse}`);
        console.log('Request completed.');
        expect(response.status).toBe(200);
        expect(response.body.length).toBe(1);
        expect(response.body[0].name).toBe('Test Plant');
    });

    test('should update a plant', async () => {
        const userId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
        const greenhouse = uuid.v4();
        const waterFrequencyDays = Math.floor(Math.random() * 365) + 1;

        const plant = {
            userId: userId,
            greenhouse: greenhouse,
            name: 'Test Plant',
            type: 'Test Type',
            location: 'Test Location',
            description: 'Test Description',
            water_frequency_days: waterFrequencyDays,
        };

        const createdPlant = await db.plants.create(plant);

        const response = await request(app)
            .put(`/api/plants/${createdPlant.id}`)
            .send({ name: 'Updated Test Plant' });

        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Plant was updated successfully.');

        const updatedPlant = await db.plants.findByPk(createdPlant.id);
        expect(updatedPlant.name).toBe('Updated Test Plant');
    });

    test('should delete a plant', async () => {
        const userId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
        const greenhouse = uuid.v4();
        const waterFrequencyDays = Math.floor(Math.random() * 365) + 1;

        const plant = {
            userId: userId,
            greenhouse: greenhouse,
            name: 'Test Plant',
            type: 'Test Type',
            location: 'Test Location',
            description: 'Test Description',
            water_frequency_days: waterFrequencyDays,
        };

        const createdPlant = await db.plants.create(plant);

        const response = await request(app).delete(`/api/plants/${createdPlant.id}`);
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Plant was deleted successfully!');

        const deletedPlant = await db.plants.findByPk(createdPlant.id);
        expect(deletedPlant).toBeNull();
    });

    test('should return 404 for a non-existent plant', async () => {
        const response = await request(app).get('/api/plants/99999');
        expect(response.status).toBe(404);
        expect(response.body.message).toBe('Plant not found with id 99999.');
    });

    afterAll(async () => {
        await db.sequelize.close();
    });
});
