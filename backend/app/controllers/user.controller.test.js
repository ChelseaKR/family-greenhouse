require('dotenv').config({ path: '.env.test' });

const ManagementClient = require('auth0').ManagementClient;
const controller = require('./user.controller');
const uuid = require('uuid');

// Simulate auth0 login process
const loggedInUser = {
    greenhouseId: uuid.v4(),
    email: 'loggedinuser@example.com',
};

jest.mock('auth0', () => {
    return {
        ManagementClient: jest.fn().mockImplementation(function () {
            return {
                createUser: jest.fn(),
            };
        }),
    };
});

describe('User Management Controller', () => {
    let req;
    let res;

    beforeEach(() => {
        req = {
            body: {
                greenhouseId: loggedInUser.greenhouseId,
                email: 'testnewuser@example.com',
            },
        };
        res = {
            status: jest.fn(() => res),
            send: jest.fn(),
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('create', () => {
        it('should create a new user with the specified greenhouseId and email', async () => {
            await controller.create(req, res);

            const expectedOptions = expect.objectContaining({
                email: req.body.email,
                user_metadata: { greenhouse: req.body.greenhouseId },
                connection: 'Username-Password-Authentication',
                verify_email: true,
            });

            expect(ManagementClient.mock.instances[0].createUser).toHaveBeenCalledWith(expectedOptions);
        });

        it('should return a 400 status if the greenhouseId or email is missing', async () => {
            req.body.greenhouseId = '';
            await controller.create(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith({
                message: "user id or email can't be empty!",
            });
        });
    });
});
